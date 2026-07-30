#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";

import {
  optionValue,
  optionValues,
  positionalValues,
  validateKnownOptions,
} from "./lib/cli-options.mjs";
import { ContextStore } from "./lib/context-store.mjs";
import {
  diagnoseStore,
  repairCurrentGeneration,
  repairWriterLock,
} from "./lib/doctor.mjs";
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
import { migrateLegacyStore } from "./tools/migrate-legacy.mjs";
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
  "migrate-legacy",
  "profile-projects",
  "refresh",
]);

const COMMON_READ_OPTIONS = ["--home", "--cwd", "--project"];
const JSON_OUTPUT = ["--json"];
const OPTIONS_BY_COMMAND = Object.freeze({
  start: { values: COMMON_READ_OPTIONS, booleans: JSON_OUTPUT },
  init: {
    values: ["--home", "--root", "--max-depth", "--codex-home"],
    booleans: ["--discover", "--yes", "--skip-codex"],
  },
  get: { values: COMMON_READ_OPTIONS, booleans: JSON_OUTPUT },
  find: { values: COMMON_READ_OPTIONS, booleans: JSON_OUTPUT },
  resolve: {
    values: [...COMMON_READ_OPTIONS, "--depth"],
    booleans: JSON_OUTPUT,
  },
  project: { values: COMMON_READ_OPTIONS, booleans: JSON_OUTPUT },
  put: {
    values: [...COMMON_READ_OPTIONS, "--json", "--file"],
    booleans: ["--take-ownership"],
  },
  doctor: {
    values: [...COMMON_READ_OPTIONS, "--repair-current"],
    booleans: ["--repair-lock", "--force"],
  },
  coverage: {
    values: [...COMMON_READ_OPTIONS, "--max-age-days"],
    booleans: [...JSON_OUTPUT, "--require-ready"],
  },
  ask: { values: COMMON_READ_OPTIONS, booleans: JSON_OUTPUT },
  "install-codex": {
    values: ["--home", "--codex-home"],
  },
  rollback: {
    values: ["--home", "--manifest"],
    booleans: ["--force"],
  },
  "inventory-codex": {
    values: [
      "--home",
      "--root",
      "--codex-home",
      "--max-depth",
      "--max-entries",
    ],
  },
  "migrate-projects": {
    values: ["--home", "--from"],
    booleans: ["--force", "--dry-run"],
  },
  "migrate-legacy": {
    values: ["--home", "--from"],
    booleans: ["--dry-run"],
  },
  "profile-projects": {
    values: ["--home", "--project"],
    booleans: ["--dry-run"],
  },
  refresh: {
    values: ["--home", "--project", "--root", "--max-depth"],
    booleans: ["--discover", "--yes", "--dry-run"],
  },
});

function validateOptionValues(command, args) {
  const options = OPTIONS_BY_COMMAND[command];
  validateKnownOptions(args, {
    command,
    valueOptions: options?.values,
    booleanOptions: options?.booleans,
  });
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
    const positional = positionalValues(
      args,
      OPTIONS_BY_COMMAND[command]?.values,
    );
    const requiredArgument = command === "find"
      ? "query"
      : command === "ask"
        ? "intent"
        : ["get", "resolve"].includes(command)
          ? "id"
          : null;
    if (requiredArgument && !positional[0]) {
      throw new ContextError("missing-argument", {
        command,
        argument: requiredArgument,
      });
    }
    if (command === "ask" && !positional[1] && !project) {
      throw new ContextError("missing-argument", {
        command,
        argument: "project",
      });
    }
    let result;
    if (command === "init") {
      const initialized = await initializeStateHome({ destination: stateHome });
      const discoverRoots = optionValues(args, "--root").map(nativePath);
      const discover = args.includes("--discover") || discoverRoots.length > 0;
      const discovery = discover
        ? await refreshProjects({
          home: stateHome,
          discoverRoots,
          confirm: args.includes("--yes"),
          maxDepth: Number(optionValue(args, "--max-depth", 4)),
        })
        : null;
      const installAdapter = args.includes("--yes")
        && !args.includes("--skip-codex");
      const explicitHomes = optionValues(args, "--codex-home");
      const codex = installAdapter
        ? await installCodex({
          homes: explicitHomes.length > 0
            ? explicitHomes.map(nativePath)
            : defaultCodexHomes({ env }),
          stateHome,
        })
        : null;
      result = {
        ok: true,
        ...initialized,
        ...(discovery ? { discovery } : {}),
        ...(codex ? { codex } : {}),
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
        dryRun: args.includes("--dry-run"),
      });
      stdout(JSON.stringify(result));
      return 0;
    }
    if (command === "migrate-legacy") {
      result = await migrateLegacyStore({
        home: stateHome,
        sourceHome: nativePath(optionValue(args, "--from", null)),
        dryRun: args.includes("--dry-run"),
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
        dryRun: args.includes("--dry-run"),
      });
      stdout(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }
    if (command === "doctor") {
      const repairs = [];
      if (args.includes("--repair-lock")) {
        repairs.push(await repairWriterLock({
          home: stateHome,
          force: args.includes("--force"),
        }));
      }
      const repairCurrent = optionValue(args, "--repair-current", null);
      if (repairCurrent) {
        repairs.push(await repairCurrentGeneration({
          home: stateHome,
          generation: repairCurrent,
        }));
      }
      result = await diagnoseStore({
        home: stateHome,
        cwd: commandCwd,
        project,
        env,
      });
      if (repairs.length > 0) result.repairs = repairs;
      stdout(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }
    const store = await ContextStore.open({
      home: stateHome,
      cwd: commandCwd,
      project,
    });
    if (command === "start") {
      result = await store.start();
    } else if (command === "get") {
      result = await store.get(positional[0]);
    } else if (command === "find") {
      result = await store.find(positional.join(" "));
    } else if (command === "resolve") {
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
      const file = optionValue(args, "--file", null);
      if (encoded !== null && file !== null) {
        throw new ContextError("invalid-option", {
          command,
          options: ["--json", "--file"],
          reason: "mutually-exclusive",
        });
      }
      let record;
      try {
        const input = encoded
          ?? (file === null ? await stdin() : await readFile(nativePath(file), "utf8"));
        record = JSON.parse(input);
      } catch (error) {
        throw wrapError(
          error,
          "invalid-json",
          "Unable to parse the record supplied to agentctx put",
          {
            source: encoded !== null
              ? "--json"
              : file !== null
                ? "--file"
                : "stdin",
          },
        );
      }
      result = await store.put(record, {
        takeOwnership: args.includes("--take-ownership"),
      });
    } else if (command === "coverage") {
      const maxAgeDays = Number(optionValue(args, "--max-age-days", 30));
      result = await store.coverage({
        project: optionValue(args, "--project", null),
        maxAgeDays,
      });
    } else if (command === "ask") {
      const askProject = positional[1] ?? project;
      result = await store.ask(positional[0], askProject);
    }
    stdout(JSON.stringify(result));
    if (
      command === "coverage"
      && args.includes("--require-ready")
      && result.ready !== result.reachable
    ) {
      return 1;
    }
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
