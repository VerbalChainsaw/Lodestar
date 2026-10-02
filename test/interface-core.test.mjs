import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fixture } from "./helpers/contract.mjs";
import { COMMANDS, MUTATION_INPUTS, READ_OPERATIONS } from "../src/cli-commands.mjs";
import { callNativeTool } from "../codex-plugin/scripts/lodestar-mcp.mjs";
import { buildReadArgs } from "../src/interface-client.mjs";

test("typed reads preserve short help and version names as literal record IDs", async (t) => {
  const f = await fixture(t);
  const descriptor = (await f.cli(["--help"])).value.data.operations.find(({ id }) => id === "get");
  for (const id of ["-h", "-v", "--help", "knowledge:normal"]) {
    await f.create(id, "knowledge", { literal: id });
    const bytes = await readFile(f.database);
    const read = await f.cli(buildReadArgs(descriptor, { id }));
    assert.equal(read.code, 0);
    assert.equal(read.value.operation, "get", `${id} must not invoke global help/version`);
    assert.equal(read.value.data.id, id);
    assert.deepEqual(await readFile(f.database), bytes);
  }
});

test("capabilities classify every command and preserve mutation schemas", async (t) => {
  const f = await fixture(t);
  const result = await f.cli(["--help"]);
  assert.equal(result.code, 0);
  const { capability_version, operations } = result.value.data;
  const native = await callNativeTool("lodestar_describe");
  assert.equal(native.capability_version, capability_version);
  assert.deepEqual(native.operations, operations);
  assert.equal(capability_version, 1);
  const shape = JSON.parse(await readFile(new URL("./interface-shape.fixture.json", import.meta.url), "utf8"));
  assert.equal(capability_version, shape.capability_version);
  for (const expected of shape.required_operations) {
    const actual = operations.find(({ id }) => id === expected.id);
    assert.deepEqual({ id: actual.id, argv: actual.argv, effect: actual.effect }, expected);
  }
  assert.deepEqual(new Set(operations.map(({ id }) => id)).size, operations.length);
  assert.deepEqual(new Set(operations.map(({ argv }) => argv[0])), new Set(Object.keys(COMMANDS)));
  for (const operation of operations) {
    assert.equal(operation.effect === "read", Object.hasOwn(READ_OPERATIONS, operation.id));
    if (operation.effect === "read") assert.ok(Array.isArray(operation.parameters), operation.id);
    if (Object.hasOwn(MUTATION_INPUTS, operation.id)) {
      assert.deepEqual(operation.input_schema, MUTATION_INPUTS[operation.id]);
      assert.equal(operation.effect, "domain_write");
      assert.ok(operation.mutation_request);
    }
  }
  assert.equal(operations.find(({ id }) => id === "decision.status").effect, "domain_write");
  const find = operations.find(({ id }) => id === "find");
  assert.deepEqual(find.constraints, [{ kind: "exactly_one", parameters: ["query", "all"] }]);
  assert.deepEqual(operations.find(({ id }) => id === "doctor").parameters, []);
  for (const operation of operations) {
    const declared = COMMANDS[operation.argv[0]];
    const allowed = operation.id === "work.check"
      ? declared.values.filter((flag) => !["--limit", "--file"].includes(flag))
      : ["work.prepare-capture", "work.attention"].includes(operation.id)
        ? declared.values.filter((flag) => !["--limit", "--session", "--agent", "--harness",
          ...(operation.id === "work.attention" ? ["--file"] : [])].includes(flag))
        : declared.values;
    assert.deepEqual(operation.cli_inputs.command_values.map(({ flag }) => flag), allowed);
    assert.deepEqual(operation.cli_inputs.command_booleans, declared.booleans);
    assert.ok(operation.cli_inputs.role.includes("generic form"));
  }
  for (const id of ["work.status", "work.history"]) {
    const flags = operations.find((operation) => operation.id === id).cli_inputs.command_values.map(({ flag }) => flag);
    assert.ok(flags.includes("--limit"), id);
  }
  for (const [id, flags] of Object.entries({
    manager: ["--interface-config", "--project", "--cwd"],
    doctor: ["--source"],
    start: ["--cwd", "--session", "--agent", "--harness", "--topic", "--target"],
    setup: ["--target", "--wsl-shim", "--posix-shim"],
    init: ["--file"],
  })) {
    const descriptor = operations.find((entry) => entry.id === id);
    for (const flag of flags) assert.ok(descriptor.cli_inputs.command_values.find((item) =>
      item.flag === flag && item.schema.type === "string"), `${id} ${flag}`);
  }
  assert.deepEqual(operations.find(({ id }) => id === "doctor").cli_inputs.command_booleans,
    ["--migration-preflight", "--recovery-preflight"]);
  assert.deepEqual(operations.find(({ id }) => id === "setup").cli_inputs.command_booleans,
    ["--apply", "--replace-local"]);
  assert.equal(operations.find(({ id }) => id === "find").cli_inputs.command_values
    .find(({ flag }) => flag === "--limit").schema.minimum, 1);
  assert.deepEqual(result.value.data.operations.find(({ id }) => id === "find").constraints,
    native.operations.find(({ id }) => id === "find").constraints);
  for (const id of ["skills.verify", "agents.status", "agents.verify", "agents.template"]) {
    const descriptor = operations.find((entry) => entry.id === id);
    assert.ok(descriptor.parameters.every((param) => !param.schema.enum || param.schema.type === "string"), id);
  }
  assert.equal(result.value.data.commands.find(({ name }) => name === "doctor").name, "doctor");
  const managerHelp = await f.cli(["manager", "--help"]);
  assert.equal(managerHelp.code, 0);
  assert.equal(managerHelp.value.data.command, "manager");
  assert.deepEqual(managerHelp.value.data.operations.map(({ id }) => id), ["manager"]);
  assert.deepEqual(managerHelp.value.data.global_values, ["--db <path>", "--output <new-file>"]);
  assert.ok(managerHelp.value.data.global_booleans.includes("--human"));
  assert.equal(managerHelp.value.data.global_values.some((item) => item.includes("--args-stdin")), false);
  assert.deepEqual(managerHelp.value.data.argument_transport.alternatives,
    ["--args-file <JSON-array-file>", "--args-stdin"]);
});

test("packaged toolchain install matches current version and qualifies init", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const guide = await readFile(new URL("../managed-assets/skills/lodestar/references/toolchain.md", import.meta.url), "utf8");
  assert.ok(guide.includes(`npm install --global lodestar-agent-context@${pkg.version}`));
  assert.match(guide, /lodestar init.*only to create an explicitly new store/u);
  assert.match(guide, /installation and migration guide/u);
  assert.equal(/lodestar-agent-context@2\.2\.0/u.test(guide), false);
});

test("find --all has stable pages, exclusions, and revision-bound continuation", async (t) => {
  const f = await fixture(t);
  const empty = await f.cli(["find", "--all"]);
  assert.equal(empty.code, 0, JSON.stringify(empty.value));
  assert.equal(empty.value.data.all, true);
  assert.equal(empty.value.data.query, null);
  assert.deepEqual(empty.value.data.records, []);
  for (const id of ["knowledge:z", "knowledge:a", "knowledge:m"]) await f.create(id, "knowledge", { id });
  const first = await f.cli(["find", "--all", "--limit", "2"]);
  assert.equal(first.code, 0, JSON.stringify(first.value));
  assert.deepEqual(first.value.data.records.map(({ id }) => id), ["knowledge:a", "knowledge:m"]);
  assert.equal(first.value.more, true);
  assert.deepEqual(first.value.next[0].args.slice(0, 3), ["--all", "--limit", "2"]);
  const second = await f.cli(["find", ...first.value.next[0].args]);
  assert.deepEqual(second.value.data.records.map(({ id }) => id), ["knowledge:z"]);
  assert.equal(second.value.more, false);
  const internal = await f.cli(["find", "--all", "--kind", "mutation-receipt", "--history", "--limit", "100"]);
  assert.equal(internal.code, 0);
  assert.ok(internal.value.data.records.length > 0);
  assert.ok(internal.value.data.records.every(({ kind }) => kind === "mutation-receipt"));
  const historical = await f.cli(["find", "--all", "--history", "--limit", "100"]);
  assert.ok(historical.value.data.records.some(({ kind }) => kind === "mutation-receipt"));
  assert.notEqual((await f.cli(["find"])).code, 0);
  assert.notEqual((await f.cli(["find", "needle", "--all"])).code, 0);
  assert.notEqual((await f.cli(["find", ""])).code, 0);
  await f.create("knowledge:new", "knowledge", {});
  const stale = await f.cli(["find", ...first.value.next[0].args]);
  assert.equal(stale.value.error.code, "read_revision_conflict");
});

test("domain paging discovery matches the live parser and names a supported correction", async (t) => {
  const f = await fixture(t);
  const help = (await f.cli(["--help"])).value.data.operations;
  const native = (await callNativeTool("lodestar_describe")).operations;
  for (const operations of [help, native]) {
    for (const id of ["decision.show", "handoff.status", "handoff.history", "work.status", "work.history", "pending.list"]) {
      const entry = operations.find((operation) => operation.id === id);
      assert.ok(entry.parameters.some(({ name }) => name === "limit"), id);
      assert.ok(entry.cli_inputs.command_values.some(({ flag }) => flag === "--limit"), id);
      assert.ok(entry.cli_inputs.command_values.some(({ flag }) => flag === "--at-revision"), id);
    }
  }
  const before = await readFile(f.database);
  const revision = (await f.cli(["doctor"])).value.revision;
  for (const argv of [["decision", "show"], ["handoff", "status"], ["handoff", "history"]]) {
    const descriptor = help.find(item => item.id === argv.join('.'));
    const result = await f.cli(buildReadArgs(descriptor, { cwd: f.root, limit: 1, at_revision: revision }));
    assert.equal(result.value.ok, true, JSON.stringify(result.value));
    assert.equal(result.value.revision, revision);
    const invalid = await f.cli([...argv, '--cwd', f.root, '--limit', '0']);
    assert.equal(invalid.value.ok, false);
    assert.equal(invalid.value.error.code, 'invalid_input', JSON.stringify(invalid.value));
    assert.match(invalid.value.error.action, /limit|integer|positive|supported/i);
  }
  assert.deepEqual(await readFile(f.database), before);
});

test('paging offset refusal names the actual supported correction without changing data', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.database);
  for (const offset of ['-1', '0.5', '9007199254740992']) {
    const result = await f.cli(['find', '--all', '--offset', offset]);
    assert.equal(result.value.ok, false);
    assert.equal(result.value.error.code, 'invalid_input');
    assert.equal(result.value.error.identifiers.field, 'offset');
    assert.match(result.value.error.action, /nonnegative safe integer/);
    assert.match(result.value.error.action, /--offset 0/);
  }
  const valid = await f.cli(['find', '--all', '--offset', '0']);
  assert.equal(valid.value.ok, true, JSON.stringify(valid.value));
  assert.deepEqual(await readFile(f.database), before);
});
