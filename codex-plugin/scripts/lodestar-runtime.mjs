import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION } from "../../src/schema.mjs";
import { canonicalStringify, decodeUtf8, parseJsonText } from "../../src/json.mjs";

const PACKAGE_ENTRY = fileURLToPath(new URL("../../lodestar.mjs", import.meta.url));

export function resolveLaunch(env = process.env) {
  if (env.LODESTAR_NODE && env.LODESTAR_ENTRY) {
    return { command: env.LODESTAR_NODE, args: [env.LODESTAR_ENTRY] };
  }
  if (existsSync(PACKAGE_ENTRY)) return { command: process.execPath, args: [PACKAGE_ENTRY] };
  return { command: env.LODESTAR_COMMAND || "lodestar", args: [] };
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
  const commandArgs = input === "" ? ["--args-stdin"] : args;
  const stdin = input === "" ? canonicalStringify(args) : input;
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args, ...commandArgs], {
      cwd: process.cwd(), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
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
