import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.mjs";
import { lodestarError } from "../src/errors.mjs";

function capture(input = "") {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin: Readable.from([input]),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    output: () => ({ stdout, stderr }),
  };
}

async function invoke(args, input = "") {
  const result = capture(input);
  const exitCode = await runCli(args, result.io);
  return { exitCode, ...result.output() };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function inputRecord() {
  return {
    id: "record:cli",
    type: "note",
    name: "CLI record",
    scope: "global",
    content: { state: "known", value: "searchable phrase" },
    aliases: ["cli alias"],
    links: [],
    sources: [],
  };
}

test("CLI initializes, writes, reads, searches, diagnoses, and exports JSON", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  const common = ["--db", file];

  const initialized = await invoke(["init", ...common]);
  assert.equal(initialized.exitCode, 0);
  assert.equal(JSON.parse(initialized.stdout).data.created, true);

  const put = await invoke(
    ["put", ...common],
    JSON.stringify(inputRecord()),
  );
  assert.equal(put.exitCode, 0, put.stderr);
  assert.equal(JSON.parse(put.stdout).data.id, "record:cli");

  const get = await invoke(["get", "cli alias", ...common]);
  assert.equal(get.exitCode, 0, get.stderr);
  assert.equal(JSON.parse(get.stdout).data.content.state, "known");

  const find = await invoke(["find", "searchable", ...common]);
  assert.deepEqual(
    JSON.parse(find.stdout).data.records.map(({ id }) => id),
    ["record:cli"],
  );

  const doctor = await invoke(["doctor", ...common]);
  assert.equal(doctor.exitCode, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).data.healthy, true);

  const exported = await invoke(["export", ...common]);
  assert.equal(JSON.parse(exported.stdout).data.records.length, 1);
});

test("every public command help path is JSON and side-effect free", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "missing", "lodestar.db");
  const commands = [
    "init",
    "put",
    "get",
    "find",
    "links",
    "delete",
    "doctor",
    "import",
    "export",
  ];
  for (const args of [["--help"], ["--version"]]) {
    const result = await invoke([...args, "--db", file]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
  for (const command of commands) {
    const result = await invoke([
      command,
      "--help",
      "--db",
      file,
    ]);
    assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.command, command);
  }
  await assert.rejects(access(path.dirname(file)), { code: "ENOENT" });
});

test("the public links and delete commands operate through JSON", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  const common = ["--db", file];
  await invoke(["init", ...common]);
  await invoke(["put", ...common], JSON.stringify(inputRecord()));
  await invoke(["put", ...common], JSON.stringify({
    ...inputRecord(),
    id: "record:linked",
    name: "Linked",
    aliases: [],
    links: [{ relationship: "related", to_id: "record:cli" }],
  }));

  const links = await invoke(["links", "record:cli", ...common]);
  assert.equal(links.exitCode, 0, links.stderr);
  assert.deepEqual(
    JSON.parse(links.stdout).data.links.map(
      ({ direction, relationship, from_id: fromId }) =>
        [direction, relationship, fromId],
    ),
    [["incoming", "related", "record:linked"]],
  );

  const deleted = await invoke(["delete", "record:cli", ...common]);
  assert.equal(deleted.exitCode, 0, deleted.stderr);
  assert.equal(JSON.parse(deleted.stdout).data.deleted.links, 1);
  const linked = await invoke(["get", "record:linked", ...common]);
  assert.deepEqual(JSON.parse(linked.stdout).data.links, []);
});

test("read-only commands do not change database bytes or create sidecars", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  const common = ["--db", file];
  await invoke(["init", ...common]);
  await invoke(["put", ...common], JSON.stringify(inputRecord()));
  const snapshot = async () => ({
    digest: createHash("sha256").update(await readFile(file)).digest("hex"),
    entries: (await readdir(directory)).sort(),
  });
  const before = await snapshot();
  for (const args of [
    ["get", "record:cli", ...common],
    ["find", "record", ...common],
    ["links", "record:cli", ...common],
    ["doctor", ...common],
    ["export", ...common],
  ]) {
    const result = await invoke(args);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(await snapshot(), before);
  }
});

test("errors use the stable JSON structure and a nonzero exit", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await invoke(["init", "--db", file]);
  const result = await invoke(["get", "missing", "--db", file]);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    error: {
      action: "Use lodestar find or inspect the repository directly.",
      code: "record_not_found",
      identifiers: { requested: "missing" },
      message: "No record or alias matched the requested identifier.",
    },
    ok: false,
  });
});

test("the option terminator preserves flag-shaped identifiers", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  const common = ["--db", file];
  await invoke(["init", ...common]);
  await invoke(["put", ...common], JSON.stringify({
    ...inputRecord(),
    id: "--record",
    aliases: [],
  }));
  const result = await invoke(["get", ...common, "--", "--record"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.id, "--record");
});

test("put rejects malformed UTF-8 instead of replacing bytes", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await invoke(["init", "--db", file]);
  const result = capture();
  result.io.stdin = Readable.from([Buffer.from([0xff])]);
  const exitCode = await runCli(["put", "--db", file], result.io);
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(result.output().stderr).error.code, "invalid_utf8");
});

test("put rejects non-byte stream chunks instead of coercing them", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await invoke(["init", "--db", file]);
  const input = JSON.stringify({
    ...inputRecord(),
    id: "record:coerced",
    aliases: [],
  });
  const result = capture();
  result.io.stdin = Readable.from([
    Array.from(Buffer.from(input), (byte) => byte + 256),
  ]);

  const exitCode = await runCli(["put", "--db", file], result.io);
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(result.output().stderr).error.code, "invalid_input");
  const missing = await invoke(["get", "record:coerced", "--db", file]);
  assert.equal(missing.exitCode, 3);
});

test("CLI argument and error output remain bounded under hostile input", async () => {
  const result = await invoke(["x".repeat(2 * 1024 * 1024)]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.ok(Buffer.byteLength(result.stderr, "utf8") < 4096);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, "resource_limit");
  assert.equal(error.identifiers.maximum, 16 * 1024);
});

test("the CLI does not trust or amplify forged Lodestar errors", async () => {
  const forged = new Error("x".repeat(100_000));
  forged.name = "LodestarError";
  forged.code = { not: "a stable error code" };
  forged.identifiers = { value: "y".repeat(100_000) };
  forged.action = "z".repeat(100_000);
  const result = capture();
  result.io.stdin = {
    async *[Symbol.asyncIterator]() {
      throw forged;
    },
  };

  const exitCode = await runCli(["put"], result.io);
  assert.equal(exitCode, 1);
  assert.equal(result.output().stdout, "");
  assert.ok(Buffer.byteLength(result.output().stderr, "utf8") < 4096);
  assert.deepEqual(JSON.parse(result.output().stderr), {
    error: {
      action: "Retry the command. If it fails again, run lodestar doctor.",
      code: "internal_error",
      identifiers: {},
      message: "Lodestar could not complete the operation.",
    },
    ok: false,
  });
});

test("the CLI derives its envelope and exit from one error snapshot", async () => {
  const changing = lodestarError(
    "invalid_input",
    "The injected input is invalid.",
  );
  let reads = 0;
  Object.defineProperty(changing, "code", {
    get() {
      reads += 1;
      return reads === 1 ? "invalid_input" : "database_write_failed";
    },
  });
  const result = capture();
  result.io.stdin = {
    async *[Symbol.asyncIterator]() {
      throw changing;
    },
  };

  const exitCode = await runCli(["put"], result.io);
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(result.output().stderr).error.code, "invalid_input");
  assert.equal(reads, 1);
});
