import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION } from "../../src/schema.mjs";

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
  const value = JSON.parse(String(text).trim());
  if (!value || value.v !== CONTRACT_VERSION || typeof value.ok !== "boolean") {
    throw new Error(`One-shot Lodestar returned a non-contract-${CONTRACT_VERSION} envelope.`);
  }
  return value;
}

export async function runInstalledLodestar(args, { input = "", env = process.env } = {}) {
  const launch = resolveLaunch(env);
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args, ...args], {
      cwd: process.cwd(), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => {
      try {
        const envelope = parseEnvelope(status === 0 || stdout.trim() ? stdout : stderr);
        if (envelope.ok !== true) {
          const error = new Error(envelope.error?.message ?? "Lodestar operation failed.");
          error.envelope = envelope;
          reject(error);
        } else resolve(envelope);
      } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}

export function mutationCommand(operation) {
  const [family, subcommand] = operation.split(".");
  return subcommand ? [family, subcommand] : [family];
}
