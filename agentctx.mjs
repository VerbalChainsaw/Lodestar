#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import {
  optionValue,
  optionValues,
  positionalValues,
  validateKnownOptions,
} from "./lib/cli-options.mjs";
import { assertByteLimit, readFileLimited } from "./lib/bounded-io.mjs";
import { ContextStore } from "./lib/context-store.mjs";
import {
  diagnoseStore,
  repairCurrentGeneration,
  repairWriterLock,
} from "./lib/doctor.mjs";
import { errorResult, wrapError } from "./lib/errors.mjs";
import { isMainModule } from "./lib/main-entry.mjs";
import {
  maintainStore,
  recoverQuarantinedGeneration,
} from "./lib/maintenance.mjs";
import { nativeProjectPath } from "./lib/native-path.mjs";
import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "./lib/snapshot.mjs";
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

export const AGENTCTX_VERSION = "0.6.1";

const COMMAND_HELP = Object.freeze({
  start: {
    usage: "agentctx start [--cwd <path>] [--project <id>] [--home <path>]",
    summary: "Return the bounded startup context packet.",
  },
  init: {
    usage:
      "agentctx init [--home <path>] [--discover --root <path> --yes] [--skip-codex]",
    summary: "Initialize a state home and optionally discover projects.",
  },
  get: {
    usage: "agentctx get <id> [--cwd <path>] [--project <id>] [--home <path>]",
    summary: "Return one exact scope-authorized record.",
  },
  find: {
    usage:
      "agentctx find <query> [--cwd <path>] [--project <id>] [--home <path>]",
    summary: "Search bounded structured context in the authorized scope.",
  },
  resolve: {
    usage:
      "agentctx resolve <id> [--depth <1-3>] [--cwd <path>] [--project <id>]",
    summary: "Return an exact record and its bounded linked graph.",
  },
  project: {
    usage:
      "agentctx project [selector] [--cwd <path>] [--project <id>] [--home <path>]",
    summary: "Return the current or selected project card.",
  },
  put: {
    usage:
      "agentctx put (--json <record> | --file <path> | <stdin>) [--take-ownership]",
    summary: "Validate and transactionally persist one curated record.",
  },
  doctor: {
    usage:
      "agentctx doctor [--deep] [--home <path>] [--repair-current <id> | --repair-lock --force]",
    summary: "Inspect integrity, durability, health, and recovery state.",
  },
  coverage: {
    usage:
      "agentctx coverage [--project <id>] [--max-age-days <n>] [--require-ready]",
    summary: "Report project context completeness and freshness.",
  },
  ask: {
    usage: "agentctx ask <intent> <project> [--home <path>]",
    summary: "Query project context through a recognized intent.",
  },
  "install-codex": {
    usage:
      "agentctx install-codex [--codex-home <path>] [--home <path>]",
    summary: "Install or update only Lodestar's managed Codex block.",
  },
  rollback: {
    usage:
      "agentctx rollback [--manifest <path>] [--codex-home <path>] [--force]",
    summary: "Restore adapter-managed Codex files from a validated backup.",
  },
  "inventory-codex": {
    usage:
      "agentctx inventory-codex --root <path> [--codex-home <path>] [--home <path>]",
    summary: "Inventory bounded Codex source metadata without file contents.",
  },
  "migrate-projects": {
    usage:
      "agentctx migrate-projects --from <registry.json> [--dry-run] [--force]",
    summary: "Preview or merge a bounded project registry.",
  },
  "migrate-legacy": {
    usage:
      "agentctx migrate-legacy --from <legacy-home> [--home <path>] [--dry-run]",
    summary: "Import a legacy flat store without modifying its source.",
  },
  "profile-projects": {
    usage:
      "agentctx profile-projects [--project <id>] [--home <path>] [--dry-run]",
    summary: "Refresh bounded generated project metadata.",
  },
  refresh: {
    usage:
      "agentctx refresh [--project <id>] [--discover --root <path> --yes] [--dry-run]",
    summary: "Profile projects and optionally discover explicit roots.",
  },
  snapshot: {
    usage:
      "agentctx snapshot (--to <path> [--home <path>] | --verify <path>)",
    summary: "Create or independently verify a portable snapshot.",
  },
  restore: {
    usage:
      "agentctx restore --from <snapshot> --home <new-path> [--dry-run]",
    summary: "Verify and restore a snapshot without overwriting state.",
  },
  maintain: {
    usage:
      "agentctx maintain [--retain <n>] [--audit-max-bytes <n>] [--apply]",
    summary: "Preview or apply recoverable retention and audit maintenance.",
  },
  recover: {
    usage:
      "agentctx recover <generation> [--promote] [--home <path>]",
    summary: "Validate and restore one quarantined generation.",
  },
});

const COMMANDS = Object.freeze(Object.keys(COMMAND_HELP));

export function helpText(command = null) {
  if (command) {
    const entry = COMMAND_HELP[command];
    if (!entry) return null;
    return [
      `Lodestar agentctx ${AGENTCTX_VERSION}`,
      "",
      `Usage: ${entry.usage}`,
      "",
      entry.summary,
      "",
      "All operational results are emitted as JSON.",
      "Run `agentctx --help` to list every command.",
    ].join("\n");
  }
  const width = Math.max(...COMMANDS.map((name) => name.length));
  return [
    `Lodestar agentctx ${AGENTCTX_VERSION}`,
    "Local deterministic context and project discovery for coding agents.",
    "",
    "Usage:",
    "  agentctx <command> [options]",
    "  agentctx help [command]",
    "  agentctx --version",
    "",
    "Commands:",
    ...COMMANDS.map((name) =>
      `  ${name.padEnd(width)}  ${COMMAND_HELP[name].summary}`),
    "",
    "Run `agentctx <command> --help` for command usage.",
  ].join("\n");
}

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
    booleans: ["--repair-lock", "--force", "--deep"],
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
    values: ["--home", "--manifest", "--codex-home"],
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
  snapshot: {
    values: ["--home", "--to", "--verify"],
  },
  restore: {
    values: ["--home", "--from"],
    booleans: ["--dry-run"],
  },
  maintain: {
    values: ["--home", "--retain", "--audit-max-bytes"],
    booleans: ["--apply", "--skip-drift"],
  },
  recover: {
    values: ["--home"],
    booleans: ["--promote"],
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

const MAX_PUT_INPUT_BYTES = 128 * 1024;

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_PUT_INPUT_BYTES) {
      throw new ContextError("resource-limit-exceeded", {
        resource: "put-input-bytes",
        actual: bytes,
        maximum: MAX_PUT_INPUT_BYTES,
      });
    }
    chunks.push(chunk);
  }
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
    if (
      ["--version", "-v", "version"].includes(command)
      && args.length === 0
    ) {
      stdout(AGENTCTX_VERSION);
      return 0;
    }
    if (["--help", "-h", "help"].includes(command)) {
      const requested = command === "help" ? args[0] ?? null : null;
      if (requested && !COMMANDS.includes(requested)) {
        throw new ContextError("unknown-command", {
          command: requested,
          commands: COMMANDS,
        });
      }
      stdout(helpText(requested));
      return 0;
    }
    if (
      COMMANDS.includes(command)
      && args.length === 1
      && ["--help", "-h"].includes(args[0])
    ) {
      stdout(helpText(command));
      return 0;
    }
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
        : ["get", "resolve", "recover"].includes(command)
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
        allowedHomes: (() => {
          const selected = optionValues(args, "--codex-home");
          return selected.length > 0
            ? selected.map(nativePath)
            : defaultCodexHomes({ env });
        })(),
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
    if (command === "snapshot") {
      const destination = optionValue(args, "--to", null);
      const verify = optionValue(args, "--verify", null);
      if (Boolean(destination) === Boolean(verify)) {
        throw new ContextError("invalid-option", {
          command,
          options: ["--to", "--verify"],
          reason: "exactly-one-required",
        });
      }
      result = verify
        ? await verifySnapshot({ snapshot: nativePath(verify) })
        : await createSnapshot({
          home: stateHome,
          destination: nativePath(destination),
        });
      stdout(JSON.stringify(result));
      return 0;
    }
    if (command === "restore") {
      const source = optionValue(args, "--from", null);
      if (!source) {
        throw new ContextError("missing-argument", {
          command,
          argument: "--from",
        });
      }
      result = await restoreSnapshot({
        snapshot: nativePath(source),
        destination: stateHome,
        dryRun: args.includes("--dry-run"),
      });
      stdout(JSON.stringify(result));
      return 0;
    }
    if (command === "maintain") {
      result = await maintainStore({
        home: stateHome,
        apply: args.includes("--apply"),
        retain: Number(optionValue(args, "--retain", 10)),
        auditMaxBytes: Number(
          optionValue(args, "--audit-max-bytes", 4 * 1024 * 1024),
        ),
        checkDrift: !args.includes("--skip-drift"),
      });
      stdout(JSON.stringify(result));
      return 0;
    }
    if (command === "recover") {
      result = await recoverQuarantinedGeneration({
        home: stateHome,
        generation: positional[0],
        promote: args.includes("--promote"),
      });
      stdout(JSON.stringify(result));
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
        deep: args.includes("--deep"),
      });
      result.runtime = {
        package_version: AGENTCTX_VERSION,
        node_version: process.versions.node,
      };
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
          ?? (file === null
            ? await stdin()
            : await readFileLimited(nativePath(file), {
              maximum: MAX_PUT_INPUT_BYTES,
              encoding: "utf8",
              resource: "put-input-bytes",
            }));
        assertByteLimit(input, {
          maximum: MAX_PUT_INPUT_BYTES,
          resource: "put-input-bytes",
        });
        record = JSON.parse(input);
      } catch (error) {
        if (error.code === "resource-limit-exceeded") throw error;
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
