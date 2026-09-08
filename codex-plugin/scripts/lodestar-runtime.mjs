import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, HOST_OPTIONS, PATH_OPTIONS } from "../../src/cli-commands.mjs";
import { CONTRACT_VERSION } from "../../src/schema.mjs";
import { canonicalStringify, decodeUtf8, parseJsonText } from "../../src/json.mjs";

const PACKAGE_ENTRY = fileURLToPath(new URL("../../lodestar.mjs", import.meta.url));
const WINDOWS_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/u;
const WSL_UNC = /^(?:\\\\wsl(?:\.localhost|\$)\\|\/\/wsl(?:\.localhost|\$)\/)/iu;
const stripTerminalNewline = (value) => value.replace(/\r?\n$/u, "");

function isWsl(env) {
  return process.platform === "linux" && Boolean(env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim());
}

export function resolveLaunch(env = process.env) {
  if (env.LODESTAR_NODE && env.LODESTAR_ENTRY) {
    return { command: env.LODESTAR_NODE, args: [env.LODESTAR_ENTRY] };
  }
  if (isWsl(env)) return { command: env.LODESTAR_COMMAND || "lodestar", args: [], wsl: true };
  if (existsSync(PACKAGE_ENTRY)) return { command: process.execPath, args: [PACKAGE_ENTRY] };
  return { command: env.LODESTAR_COMMAND || "lodestar", args: [] };
}

function wslWindowsPath(value, env) {
  if (WINDOWS_PATH.test(value)) return value;
  const source = path.posix.isAbsolute(value) ? value : path.resolve(value);
  const result = spawnSync("wslpath", ["-w", source], {
    encoding: "utf8", env, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `wslpath could not convert ${value}.`);
  return stripTerminalNewline(result.stdout);
}

function resolvedWslLauncher(command, env) {
  if (command.includes("/")) return path.resolve(command);
  const result = spawnSync("bash", ["-c", 'command -v -- "$1"', "bash", command], {
    encoding: "utf8", env, windowsHide: true,
  });
  if (result.error) throw result.error;
  const selected = stripTerminalNewline(result.stdout);
  if (result.status !== 0 || !selected) {
    throw new Error(`The selected WSL Lodestar launcher is unavailable: ${command}.`);
  }
  return selected;
}

function rejectLinuxDatabase(option, value) {
  if ((option === "--db" || option === "--source") && WSL_UNC.test(value)) {
    throw new Error("SQLite must remain on a Windows filesystem; use a Windows drive or /mnt/<drive> path.");
  }
}

function normalizeWslReadArguments(args, launch, env) {
  const normalized = [...args];
  const flags = new Map();
  let optionEnd = normalized.length;
  for (let index = 0; index < normalized.length; index += 1) {
    const option = normalized[index];
    if (option === "--") { optionEnd = index; break; }
    if (!PATH_OPTIONS.includes(option)) continue;
    if (index + 1 >= normalized.length || normalized[index + 1].startsWith("--")) {
      throw new Error(`${option} requires a path.`);
    }
    const converted = wslWindowsPath(normalized[index + 1], env);
    rejectLinuxDatabase(option, converted);
    normalized[index + 1] = converted;
    flags.set(option, converted);
    index += 1;
  }

  const command = normalized[0];
  const defaults = [];
  const addPath = (option, value) => {
    const converted = wslWindowsPath(value, env);
    rejectLinuxDatabase(option, converted);
    defaults.push(option, converted);
  };
  if (COMMANDS[command]?.values.includes("--cwd") && !flags.has("--cwd")) {
    addPath("--cwd", process.cwd());
  }
  const hostCommand = command === "start" || command === "skills" || command === "setup";
  if ((command === "start" || command === "setup")
      && !flags.has("--home") && !flags.has("--wsl-shim") && !flags.has("--posix-shim")) {
    addPath("--wsl-shim", resolvedWslLauncher(launch.command, env));
  }
  if (hostCommand) {
    const explicitHome = flags.get("--home");
    const home = explicitHome ?? env.HOME;
    if (!home) throw new Error("HOME is required for WSL Lodestar host operations.");
    if (!explicitHome) addPath("--home", home);
    if (!flags.has("--hermes-home")) {
      defaults.push("--hermes-home", explicitHome
        ? path.win32.join(explicitHome, ".hermes")
        : wslWindowsPath(env.HERMES_HOME?.trim() || path.posix.join(home, ".hermes"), env));
    }
    if (!explicitHome) {
      const environmentHomes = {
        "--codex-home": env.CODEX_HOME,
        "--claude-home": env.CLAUDE_CONFIG_DIR,
        "--xdg-config-home": env.XDG_CONFIG_HOME,
        "--opencode-root": env.OPENCODE_CONFIG_DIR
          ? path.posix.join(env.OPENCODE_CONFIG_DIR, "skills") : undefined,
      };
      for (const option of Object.keys(HOST_OPTIONS)) {
        if (!flags.has(option) && environmentHomes[option]?.trim()) addPath(option, environmentHomes[option]);
      }
    }
  }
  normalized.splice(optionEnd, 0, ...defaults);
  return { arguments: normalized, database: flags.get("--db") };
}

export function packageVersion() {
  try {
    const manifest = fileURLToPath(new URL("../../package.json", import.meta.url));
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return "unknown";
  }
}

export function parseEnvelope(text) {
  const value = parseJsonText(typeof text === "string" ? text : decodeUtf8(text), { resource: "command_response" });
  if (!value || value.v !== CONTRACT_VERSION || typeof value.ok !== "boolean") {
    throw new Error(`One-shot Lodestar returned a non-contract-${CONTRACT_VERSION} envelope.`);
  }
  return value;
}

export async function runInstalledLodestar(args, { input = "", env = process.env } = {}) {
  const launch = resolveLaunch(env);
  // Read arguments can exceed CreateProcess's command line. Pass the existing
  // command array through complete stdin; mutations already use stdin for their
  // guarded body and have only short fixed command selectors in argv.
  const wslRead = input === "" && launch.wsl
    ? normalizeWslReadArguments(args, launch, env) : null;
  const readArguments = wslRead?.arguments ?? args;
  const commandArgs = input === "" ? ["--args-stdin"] : args;
  const stdin = input === "" ? canonicalStringify(readArguments) : input;
  const childEnvironment = wslRead?.database === undefined ? env
    : { ...env, LODESTAR_DB: wslRead.database };
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args, ...commandArgs], {
      cwd: process.cwd(), env: childEnvironment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [], stderr = [];
    child.stdout.on("data", (chunk) => { stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { stderr.push(chunk); });
    child.stdin.on("error", reject);
    child.once("error", reject);
    child.once("close", (status) => {
      try {
        const output = Buffer.concat(stdout), errors = Buffer.concat(stderr);
        const envelope = parseEnvelope(status === 0 || output.length ? output : errors);
        if (envelope.ok !== true) {
          const error = new Error(envelope.error?.message ?? "Lodestar operation failed.");
          error.envelope = envelope;
          reject(error);
        } else resolve(envelope);
      } catch (error) { reject(error); }
    });
    child.stdin.end(stdin);
  });
}

export function mutationCommand(operation, request = {}) {
  const [family, subcommand] = operation.split(".");
  const checkout = request.write_basis?.checkout ?? request.checkout;
  return subcommand ? [family, subcommand,
    ...(typeof checkout === "string" ? ["--cwd", checkout] : [])] : [family];
}
