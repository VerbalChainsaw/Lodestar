import { createHash } from "node:crypto";
import path from "node:path";

import { canonicalStringify } from "./canonical-json.mjs";
import { LodestarError } from "./errors.mjs";

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replaceAll("\\", "/")
    .trim()
    .toLowerCase();
}

function normalizeAnswer(value) {
  return normalize(value)
    .replace(/^[`"']+|[`"'.]+$/g, "")
    .trim();
}

function normalizedEvidence(value) {
  return normalize(value).replace(/^\.\//, "");
}

function scoreError(message, detail = {}) {
  return new LodestarError("category-score-invalid", message, { detail });
}

export function validateAgentAnswer(answer) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    throw scoreError("Runner answer must be an object");
  }
  if (typeof answer.answer !== "string" || answer.answer.trim() === "") {
    throw scoreError("Runner answer.answer must be a non-empty string");
  }
  if (
    typeof answer.confidence !== "number"
    || !Number.isFinite(answer.confidence)
    || answer.confidence < 0
    || answer.confidence > 1
  ) {
    throw scoreError("Runner confidence must be a number from 0 to 1");
  }
  if (
    !Array.isArray(answer.evidence)
    || answer.evidence.some((entry) => typeof entry !== "string")
  ) {
    throw scoreError("Runner evidence must be an array of paths");
  }
  return {
    answer: answer.answer.trim(),
    confidence: answer.confidence,
    evidence: answer.evidence.map((entry) => entry.trim()),
    explanation:
      typeof answer.explanation === "string" ? answer.explanation.trim() : "",
  };
}

function eventPaths(events) {
  return events.flatMap((event) => {
    const candidates = [];
    if (typeof event.path === "string") candidates.push(event.path);
    if (Array.isArray(event.paths)) candidates.push(...event.paths);
    return candidates.map(normalizedEvidence);
  });
}

export function scoreCategoryTrial({
  question,
  answer: rawAnswer,
  events = [],
  canary,
  condition,
  startedAtMs,
  completedAtMs,
  leakageText = "",
} = {}) {
  const answer = validateAgentAnswer(rawAnswer);
  if (!question?.id || typeof question.answer !== "string") {
    throw scoreError("Ground-truth question is invalid");
  }
  const normalizedActual = normalizeAnswer(answer.answer);
  const expected = normalizeAnswer(question.answer);
  const correct = normalizedActual === expected;
  const evidence = answer.evidence.map(normalizedEvidence);
  const evidenceCorrect = question.evidence.some((expectedPath) =>
    evidence.includes(normalizedEvidence(expectedPath)));
  const serialized = canonicalStringify({ answer, events, leakageText });
  const leakage = normalize(serialized).includes(normalize(canary));
  const paths = eventPaths(events);
  const decoyPaths = [
    "docs/plans/2025-02-abandoned.md",
    "docs/archive/testing.md",
    "src/context/resolver-old.mjs",
    "src/service/legacy.mjs",
    "packages/legacy/agents.md",
    "other-project",
  ];
  const wrongTurns = new Set(paths.filter((candidate) =>
    decoyPaths.some((decoy) => candidate.includes(decoy))));
  const broadSearches = events.filter((event) => event.broad === true).length;
  const files = new Set(paths.filter(Boolean));
  const observedByteValues = events.map((event) => Number(event.bytes))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const bytes = observedByteValues.reduce(
    (total, value) => total + value,
    0,
  );
  const toolCalls = events.filter((event) => event.type === "tool").length;
  const usedLodestar = events.some((event) =>
    event.type === "tool"
    && /\bagentctx(?:\.mjs)?\s+(?:start|get|resolve|find)\b/i.test(
      String(event.command ?? ""),
    ));
  const requiredLodestar = condition === "lodestar";
  const confidenceError = (answer.confidence - (correct ? 1 : 0)) ** 2;
  const elapsedMs =
    Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
      ? Math.max(0, completedAtMs - startedAtMs)
      : null;
  const answerHash = createHash("sha256")
    .update(normalizedActual)
    .digest("hex");
  return {
    correct,
    evidence_correct: evidenceCorrect,
    leakage,
    confidence: answer.confidence,
    brier_score: Number(confidenceError.toFixed(6)),
    elapsed_ms: elapsedMs,
    time_to_correct_ms: correct ? elapsedMs : null,
    tool_calls: toolCalls,
    unique_files: files.size,
    bytes_observed: observedByteValues.length > 0 ? bytes : null,
    broad_searches: broadSearches,
    wrong_turns: wrongTurns.size,
    used_lodestar: usedLodestar,
    protocol_compliant: requiredLodestar ? usedLodestar : true,
    answer_hash: answerHash,
  };
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function summarizeGroup(trials) {
  const completed = trials.filter(({ status }) => status === "completed");
  const scored = completed.map(({ score }) => score);
  const usageValues = (field) => completed
    .map(({ usage }) => Number(usage?.[field]))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const reproducibilityCells = Object.values(Object.groupBy(
    completed,
    ({ question_id: questionId }) => questionId,
  )).map((cell) => {
    const hashes = cell.map(({ score }) => score.answer_hash);
    const counts = Object.values(Object.groupBy(hashes, (value) => value))
      .map((group) => group.length);
    return Math.max(...counts) / hashes.length;
  });
  const reportedCosts = usageValues("cost_usd");
  const correctCount = scored.filter(({ correct }) => correct).length;
  return {
    trials: trials.length,
    completed: completed.length,
    failed: trials.length - completed.length,
    correct_per_planned_trial:
      trials.length === 0 ? null : correctCount / trials.length,
    correctness: mean(scored.map(({ correct }) => Number(correct))),
    evidence_correctness: mean(
      scored.map(({ evidence_correct: value }) => Number(value)),
    ),
    median_elapsed_ms: median(
      scored.map(({ elapsed_ms: value }) => value).filter(Number.isFinite),
    ),
    median_time_to_correct_ms: median(
      scored.map(({ time_to_correct_ms: value }) => value)
        .filter(Number.isFinite),
    ),
    median_tool_calls: median(scored.map(({ tool_calls: value }) => value)),
    median_unique_files: median(scored.map(({ unique_files: value }) => value)),
    median_bytes_observed: median(
      scored.map(({ bytes_observed: value }) => value).filter(Number.isFinite),
    ),
    median_wrong_turns: median(scored.map(({ wrong_turns: value }) => value)),
    broad_search_rate: mean(
      scored.map(({ broad_searches: value }) => Number(value > 0)),
    ),
    leakage_rate: mean(scored.map(({ leakage }) => Number(leakage))),
    mean_brier_score: mean(scored.map(({ brier_score: value }) => value)),
    protocol_compliance: mean(
      scored.map(({ protocol_compliant: value }) => Number(value)),
    ),
    median_input_tokens: median(usageValues("input_tokens")),
    median_cached_input_tokens: median(usageValues("cached_input_tokens")),
    median_output_tokens: median(usageValues("output_tokens")),
    total_reported_cost_usd: reportedCosts.length > 0
      ? Number(reportedCosts
        .reduce((total, value) => total + value, 0).toFixed(6))
      : null,
    reported_cost_per_correct_usd:
      reportedCosts.length > 0 && correctCount > 0
        ? Number((reportedCosts.reduce(
          (total, value) => total + value,
          0,
        ) / correctCount).toFixed(6))
        : null,
    reproducibility: mean(reproducibilityCells),
  };
}

export function summarizeCategoryTrials(trials) {
  const groups = {};
  for (const trial of trials) {
    const key = [
      trial.runner_id,
      trial.scenario_id,
      trial.condition,
    ].join("/");
    (groups[key] ??= []).push(trial);
  }
  const summaries = Object.fromEntries(
    Object.entries(groups)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, summarizeGroup(values)]),
  );
  const conditions = Object.fromEntries(
    ["unmanaged", "lodestar"].map((condition) => [
      condition,
      summarizeGroup(trials.filter((trial) => trial.condition === condition)),
    ]),
  );
  const delta = (field) => {
    const unmanaged = conditions.unmanaged[field];
    const lodestar = conditions.lodestar[field];
    return Number.isFinite(unmanaged) && Number.isFinite(lodestar)
      ? Number((lodestar - unmanaged).toFixed(6))
      : null;
  };
  return {
    groups: summaries,
    conditions,
    lodestar_minus_unmanaged: Object.fromEntries([
      "correctness",
      "correct_per_planned_trial",
      "evidence_correctness",
      "median_elapsed_ms",
      "median_time_to_correct_ms",
      "median_tool_calls",
      "median_unique_files",
      "median_bytes_observed",
      "median_wrong_turns",
      "broad_search_rate",
      "leakage_rate",
      "mean_brier_score",
      "protocol_compliance",
      "median_input_tokens",
      "median_output_tokens",
      "reproducibility",
    ].map((field) => [field, delta(field)])),
    notes: [
      "Reproducibility is the dominant answer share per repeated question cell.",
      "Bytes depend on adapter trace fidelity; absent byte counts remain null.",
      "Semantic edge cases should be reviewed from retained raw transcripts.",
    ],
  };
}

export function relativeEvidencePath(workspace, candidate) {
  const absolute = path.resolve(workspace, candidate);
  const relative = path.relative(workspace, absolute);
  return relative.split(path.sep).join("/");
}
