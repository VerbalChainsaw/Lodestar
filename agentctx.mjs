#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import {
  optionValue,
  optionValues,
  positionalValues,
  validateValueOptions,
} from "./lib/cli-options.mjs";
import { ContextStore } from "./lib/context-store.mjs";
import { errorResult, wrapError } from "./lib/errors.mjs";
import { isMainModule } from "./lib/main-entry.mjs";
import { nativeProjectPath } from "./lib/native-path.mjs";
import {
  initializeStateHome,
  resolveStateHome,
} from "./lib/state-home.mjs";
import { ContextError } from "./lib/validation.mjs";
import {
  defaultCodexHomes,
  installCodex,
} from "./tools/install-codex.mjs";
import { inventoryCodex } from "./tools/inventory-codex.mjs";
import { migrateRegistry } from "./tools/migrate-projects.mjs";
import { profileProjects } from "./tools/profile-projects.mjs";
import { refreshProjects } from "./tools/refresh-projects.mjs";
import { rollbackCodex } from "./tools/rollback-codex.mjs";

const COMMANDS = Object.freeze([
  "start",
  "init",
  "get",
  "find",
  "resolve",
  "project",
  "put",
  "doctor",
  "coverage",
  "ask",
  "install-codex",
  "rollback",
  "inventory-codex",
  "migrate-projects",
  "profile-projects",
  "refresh",
]);

const VALUE_OPTIONS = new Set([
  "--home",
  "--cwd",
  "--project",
  "--depth",
  "--batch",
  "--codex-home",
  "--manifest",
  "--root",
  "--from",
  "--max-depth",
  "--max-entries",
]);

function validateOptionValues(command, args) {
  validateValueOptions(args, VALUE_OPTIONS);
  if (command === "put" && args.includes("--json")) {
    const index = args.indexOf("--json");
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ContextError("invalid-option", {
        option: "--json",
        reason: "value-required-for-put",
      });
    }
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(
  argv,
  {
    env = process.env,
    cwd = process.cwd(),
    home,
    stdin = readStdin,
    stdout = (line) => process.stdout.write(`${line}\n`),
    stderr = (line) => process.stderr.write(`${line}\n`),
  } = {},
) {
  try {
    const [command, ...args] = argv;
    if (!COMMANDS.includes(command)) {
      throw new ContextError("unknown-command", {
        command: command ?? null,
        commands: COMMANDS,
      });
    }
    validateOptionValues(command, args);
    const stateHome = resolveStateHome({
      explicit: optionValue(args, "--home", home),
      env,
      cwd,
    });
    const nativePath = (value) =>
      value === null || value === undefined
        ? value
        : nativeProjectPath(value, { env, cwd });
    const commandCwd = nativePath(optionValue(args, "--cwd", cwd));
    const project = optionValue(args, "--project", null);
    let result;
    if (command === "init") {
      result = {
        ok: true,
        ...await initializeStateHome({ destination: stateHome }),
      };
      stdout(JSON.stringify(result));
      return 0;
    }
    if (command === "install-codex") {
      const explicitHomes = optionValues(args, "--codex-home");
      result = {
        ok: true,
        ...await installCodex({
          homes: explicitHomes.length > 0
            ? explicitHomes.map(nativePath)
            : defaultCodexHomes({ env }),
          stateHome,
        }),
      };
      stdout(JSON.stringify(result));
      return 0;
    }
    if (command === "rollback") {
      result = await rollbackCodex({
        stateHome,
        manifestPath: nativePath(optionValue(args, "--manifest", null)),
        force: args.includes("--force"),
      });
      stdout(JSON.stringify(result));
      return 0;
    }
    if (command === "inventory-codex") {
      const explicitHomes = optionValues(args, "--codex-home");
      const inventory = await inventoryCodex({
        roots: optionValues(args, "--root").map(nativePath),
        codexHomes: explicitHomes.length > 0
          ? explicitHomes.map(nativePath)
          : defaultCodexHomes({ env }),
        stateHome,
        maxDepth: Number(optionValue(args, "--max-depth", 4)),
        maxEntries: Number(optionValue(args, "--max-entries", 10_000)),
      });
      stdout(JSON.stringify({
        ok: true,
        sources: inventory.sources.length,
        inventory: path.join(stateHome, "inventory", "codex-sources.json"),
      }));
      return 0;
    }
    if (command === "migrate-projects") {
      result = await migrateRegistry({
        home: stateHome,
        sourcePath: nativePath(optionValue(args, "--from", null)),
        force: args.includes("--force"),
      });
      stdout(JSON.stringify(result));
      return 0;
    }
    if (command === "refresh" && args.includes("--discover")) {
      result = await refreshProjects({
        home: stateHome,
        discoverRoots: optionValues(args, "--root").map(nativePath),
        confirm: args.includes("--yes"),
        maxDepth: Number(optionValue(args, "--max-depth", 4)),
      });
      stdout(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }
    if (command === "profile-projects" || command === "refresh") {
      result = await profileProjects({
        home: stateHome,
        projectIds: optionValues(args, "--project"),
      });
      stdout(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }
    const store = await ContextStore.open({
      home: stateHome,
      cwd: commandCwd,
      project,
    });
    const positional = positionalValues(args, [
      "--home",
      "--cwd",
      "--project",
      "--depth",
      "--json",
      "--batch",
      "--codex-home",
      "--manifest",
      "--root",
      "--from",
      "--max-depth",
      "--max-entries",
    ]);
    if (command === "start") {
      result = await store.start();
    } else if (command === "get") {
      if (!positional[0]) {
        throw new ContextError("missing-argument", {
          command,
          argument: "id",
        });
      }
      result = await store.get(positional[0]);
    } else if (command === "find") {
      if (positional.length === 0) {
        throw new ContextError("missing-argument", {
          command,
          argument: "query",
        });
      }
      result = await store.find(positional.join(" "));
    } else if (command === "resolve") {
      if (!positional[0]) {
        throw new ContextError("missing-argument", {
          command,
          argument: "id",
        });
      }
      const depth = optionValue(args, "--depth", null);
      result = await store.resolve(positional[0], {
        ...(depth === null ? {} : { depth: Number(depth) }),
      });
    } else if (command === "project") {
      result = positional.length > 0
        ? store.projectByName(positional.join(" "))
        : store.projectCard();
    } else if (command === "put") {
      const encoded = optionValue(args, "--json", null);
      let record;
      try {
        record = JSON.parse(encoded ?? await stdin());
      } catch (error) {
        throw wrapError(
          error,
          "invalid-json",
          "Unable to parse the record supplied to agentctx put",
          { source: encoded === null ? "stdin" : "--json" },
        );
      }
      result = await store.put(record);
    } else if (command === "doctor") {
      result = await store.doctor();
    } else if (command === "coverage") {
      result = await store.coverage({
        project: optionValue(args, "--project", null),
      });
    } else if (command === "ask") {
      result = await store.ask(positional[0], positional[1]);
    }
    stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    const failure = errorResult(error);
    stderr(JSON.stringify({
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        detail: failure.detail,
      },
    }));
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
