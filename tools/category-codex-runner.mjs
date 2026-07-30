#!/usr/bin/env node

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readFileLimited } from "../lib/bounded-io.mjs";
import { isMainModule } from "../lib/main-entry.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUTPUT_SCHEMA = path.join(
  PACKAGE_ROOT,
  "schema",
  "category-benchmark-answer.json",
);
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_CODEX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_FINAL_ANSWER_BYTES = 2 * 1024 * 1024;

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveCodexInvocation(
  command,
  {
    platform = process.platform,
    env = process.env,
    nodeExecutable = process.execPath,
  } = {},
) {
  if (platform !== "win32") {
    return { command, argsPrefix: [], launcher: "direct" };
  }
  const hasPath = path.isAbsolute(command) || /[\\/]/.test(command);
  const directories = hasPath
    ? [path.dirname(path.resolve(command))]
    : String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const basename = hasPath ? path.basename(command) : command;
  const extension = path.extname(basename).toLowerCase();
  const names = extension
    ? [basename]
    : [`${basename}.exe`, `${basename}.cmd`, `${basename}.ps1`, basename];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (!await exists(candidate)) continue;
      if (path.extname(candidate).toLowerCase() === ".exe") {
        return {
          command: candidate,
          argsPrefix: [],
          launcher: "native-executable",
        };
      }
      const codexJs = path.join(
        directory,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      if (await exists(codexJs)) {
        const siblingNode = path.join(directory, "node.exe");
        return {
          command: await exists(siblingNode) ? siblingNode : nodeExecutable,
          argsPrefix: [codexJs],
          launcher: "npm-node-entrypoint",
        };
      }
      throw new Error(
        `Unsupported Windows Codex launcher at ${candidate}. `
          + "Pass --codex with the native executable or standard npm shim.",
      );
    }
  }
  return { command, argsPrefix: [], launcher: "unresolved-direct" };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function validateOptions(args) {
  const valued = new Set(["--codex", "--model", "--reasoning-effort"]);
  const flags = new Set(["--allow-user-context"]);
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (flags.has(current)) continue;
    if (!valued.has(current)) throw new Error(`Unknown option: ${current}`);
    index += 1;
  }
  return {
    codex: option(args, "--codex") ?? "codex",
    model: option(args, "--model"),
    reasoningEffort: option(args, "--reasoning-effort"),
    allowUserContext: args.includes("--allow-user-context"),
  };
}

async function readStdin(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error("Runner request exceeds 1 MiB");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function promptFor(request) {
  const lodestar = request.condition === "lodestar"
    ? [
      "This is a Lodestar-enabled repository.",
      "Your first repository-context action MUST be this exact bootstrap command:",
      request.lodestar.boot.map((part) => JSON.stringify(part)).join(" "),
      "Apply required[] and follow exact Lodestar links before repository search.",
      "If Lodestar reports a context miss, inspect only targeted repository files.",
    ].join("\n")
    : [
      "This is an unmanaged-agent-context repository.",
      "Use the repository and its ordinary instructions to determine the answer.",
      "Lodestar is not available in this condition.",
    ].join("\n");
  return `You are participating in a controlled repository-context benchmark.

${lodestar}

Question: ${request.question.prompt}

Rules:
- Work read-only.
- Stay inside the active repository at ${request.workspace}.
- Do not inspect parent or sibling projects.
- Find the current authoritative answer; stale plans and generated files may
  contain plausible conflicts.
- Return only the requested structured result.
- Put only the exact command, path, migration name, or decision ID in the
  answer field; put prose in explanation.
- Evidence paths must be relative to the active repository.
- Confidence is a number from 0 to 1 reflecting your actual uncertainty.
`;
}

function pathCandidates(command, workspace) {
  const normalizedWorkspace = path.resolve(workspace);
  const candidates = new Set();
  const matches = String(command).matchAll(
    /(?:^|[\s"'`])((?:\.{0,2}[\\/])?[\w@.+-]+(?:[\\/][\w@.+-]+)+|[\w@.+-]+\.(?:md|json|jsonl|mjs|js|ts|txt|yaml|yml))(?:$|[\s"'`;,:])/g,
  );
  for (const match of matches) {
    const raw = match[1];
    const absolute = path.resolve(workspace, raw);
    const relative = path.relative(normalizedWorkspace, absolute);
    if (
      relative !== ""
      && !relative.startsWith("..")
      && !path.isAbsolute(relative)
    ) {
      candidates.add(relative.split(path.sep).join("/"));
    }
  }
  return [...candidates].sort();
}

function broadCommand(command) {
  const value = String(command);
  return [
    /\brg\s+--files(?:\s+\.|\s*$)/i,
    /\bfind\s+\.\s/i,
    /\b(?:ls|dir)\s+(?:-[^\s]*r|\/s)\b/i,
    /\bGet-ChildItem\b[^\n]*\b-Recurse\b/i,
    /\brg\b[^\n]*(?:\s+\.\s*$|\s+\/)/i,
  ].some((pattern) => pattern.test(value));
}

function normalizeEvents(rawEvents, workspace) {
  const events = [];
  let usage = null;
  for (const event of rawEvents) {
    if (event.type === "turn.completed" && event.usage) {
      usage = {
        input_tokens: event.usage.input_tokens ?? null,
        cached_input_tokens: event.usage.cached_input_tokens ?? null,
        output_tokens: event.usage.output_tokens ?? null,
        reasoning_output_tokens:
          event.usage.reasoning_output_tokens ?? null,
      };
    }
    if (
      event.type !== "item.completed"
    ) continue;
    const item = event.item;
    if (!item || item.type !== "command_execution") continue;
    const command = String(item.command ?? "");
    const output = String(
      item.aggregated_output ?? item.output ?? item.stdout ?? "",
    );
    events.push({
      type: "tool",
      tool: "shell",
      action: broadCommand(command) ? "search" : "exec",
      command,
      paths: pathCandidates(command, workspace),
      bytes: Buffer.byteLength(output),
      broad: broadCommand(command),
      status: item.status ?? null,
      exit_code: item.exit_code ?? null,
    });
  }
  return { events, usage };
}

function runCodex(command, args, prompt, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let captured = 0;
    let settled = false;
    const forwardSignal = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    const onSigterm = () => forwardSignal("SIGTERM");
    const onSigint = () => forwardSignal("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    const cleanup = () => {
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    child.on("error", fail);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        captured += chunk.length;
        if (captured > MAX_CODEX_OUTPUT_BYTES) {
          child.kill();
          fail(new Error("Codex output exceeded 32 MiB"));
          return;
        }
        (stream === child.stdout ? stdout : stderr).push(chunk);
      });
    }
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0) {
        const error = new Error(`codex exec exited with code ${code}`);
        error.detail = {
          code,
          signal,
          stderr_tail: result.stderr.slice(-4_096),
        };
        reject(error);
        return;
      }
      resolve(result);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(error);
    });
    child.stdin.end(prompt, "utf8");
  });
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Codex emitted malformed JSONL on line ${index + 1}`);
      }
    });
}

export async function run({
  args = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let temporary = null;
  try {
    const options = validateOptions(args);
    const request = JSON.parse(await readStdin(stdin));
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "lodestar-codex-"));
    const isolatedCodexHome = path.join(temporary, "codex-home");
    const isolated = !options.allowUserContext;
    if (isolated && !process.env.CODEX_API_KEY) {
      throw new Error(
        "An isolated benchmark run requires CODEX_API_KEY. "
          + "Use --allow-user-context only for a non-publishable local smoke test.",
      );
    }
    if (isolated) await fs.mkdir(isolatedCodexHome);
    const finalFile = path.join(temporary, "final.json");
    const codexArgs = [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--config",
      "shell_environment_policy.inherit=\"core\"",
      "--config",
      "shell_environment_policy.include_only=[\"PATH\",\"HOME\",\"USERPROFILE\",\"SYSTEMROOT\",\"WINDIR\",\"COMSPEC\",\"PATHEXT\",\"TEMP\",\"TMP\",\"TMPDIR\"]",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--cd",
      request.workspace,
      "--output-schema",
      OUTPUT_SCHEMA,
      "--output-last-message",
      finalFile,
    ];
    if (options.model) codexArgs.push("--model", options.model);
    if (options.reasoningEffort) {
      codexArgs.push(
        "--config",
        `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`,
      );
    }
    codexArgs.push("-");
    const codex = await resolveCodexInvocation(options.codex);
    const result = await runCodex(
      codex.command,
      [...codex.argsPrefix, ...codexArgs],
      promptFor(request),
      request.workspace,
      {
        ...process.env,
        ...(isolated ? { CODEX_HOME: isolatedCodexHome } : {}),
      },
    );
    const rawEvents = parseJsonLines(result.stdout);
    const answer = JSON.parse(await readFileLimited(finalFile, {
      maximum: MAX_FINAL_ANSWER_BYTES,
      encoding: "utf8",
      resource: "category-final-answer-bytes",
    }));
    const normalized = normalizeEvents(rawEvents, request.workspace);
    stdout.write(`${JSON.stringify({
      v: 1,
      trial_id: request.trial_id,
      status: "completed",
      answer,
      usage: normalized.usage,
      events: normalized.events,
      raw_events: rawEvents,
      adapter_diagnostics: {
        adapter: "codex-exec-json",
        model_requested: options.model,
        reasoning_effort_requested: options.reasoningEffort,
        user_context_isolated: isolated,
        publishable_context_control: isolated,
        codex_launcher: codex.launcher,
        stderr: result.stderr,
      },
    })}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({
      ok: false,
      code: "category-codex-runner-failed",
      message: error.message,
      detail: error.detail ?? {},
    })}\n`);
    return 1;
  } finally {
    if (temporary) {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await run();
}
