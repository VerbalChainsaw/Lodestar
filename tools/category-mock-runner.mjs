#!/usr/bin/env node

import { isMainModule } from "../lib/main-entry.mjs";

const ANSWERS = Object.freeze({
  "test-command": "npm run verify:ci",
  "current-migration": "202607290945_add_context_routes",
  "start-service": "npm run service:start",
  "authoritative-implementation": "src/context/resolver-v2.mjs",
  "governing-decision": "ADR-0042",
  "file-to-change": "src/context/resolver-v2.mjs",
  "unsafe-to-modify": "generated/context/routes.json",
});

const EVIDENCE = Object.freeze({
  "test-command": "docs/operations/testing-current.md",
  "current-migration": "migrations/CURRENT",
  "start-service": "config/runtime.json",
  "authoritative-implementation": "config/implementations.json",
  "governing-decision": "docs/decisions/ADR-0042.md",
  "file-to-change": "docs/ownership/context-routes.md",
  "unsafe-to-modify": "generated/context/README.md",
});

async function readStdin(stream = process.stdin, maximum = 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("Runner request exceeds 1 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function run({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const request = JSON.parse(await readStdin(stdin));
  const stale =
    request.scenario.id === "stale-lodestar"
    && request.condition === "lodestar"
    && request.question.id === "test-command";
  const answer = stale ? "npm test" : ANSWERS[request.question.id];
  const evidence = EVIDENCE[request.question.id];
  const events = request.condition === "lodestar"
    ? [{
      type: "tool",
      tool: "shell",
      action: "exec",
      command: `${request.lodestar.command.join(" ")} start`,
      paths: [],
      bytes: 2048,
      broad: false,
    }]
    : [{
      type: "tool",
      tool: "shell",
      action: "search",
      command: "rg --files .",
      paths: [
        "docs/plans/2025-02-abandoned.md",
        evidence,
      ],
      bytes: 8192,
      broad: true,
    }];
  stdout.write(`${JSON.stringify({
    v: 1,
    trial_id: request.trial_id,
    status: "completed",
    answer: {
      answer,
      confidence: stale ? 0.9 : 0.95,
      evidence: [evidence],
      explanation: "Deterministic protocol self-test result.",
    },
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      cached_input_tokens: 0,
      cost_usd: 0,
    },
    events,
    raw_events: [],
    adapter_diagnostics: {
      adapter: "deterministic-mock",
      paid_model: false,
    },
  })}\n`);
}

if (isMainModule(import.meta.url)) {
  await run();
}

