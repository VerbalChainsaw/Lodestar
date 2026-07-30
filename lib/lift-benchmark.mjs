import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ContextStore } from "./context-store.mjs";
import {
  buildGeneration,
  promoteGeneration,
} from "./generation.mjs";
import { buildIndexes } from "./indexes.mjs";

const DEFAULTS = Object.freeze({
  runs: 7,
  projectCount: 100,
  documentCount: 64,
  documentBytes: 16 * 1024,
});

const QUESTIONS = Object.freeze([
  Object.freeze({
    key: "test_command",
    value: "npm run verify:ci",
    relativePath: "docs/operations/testing.md",
    title: "Verification",
  }),
  Object.freeze({
    key: "rollback_rule",
    value: "Retain two previous artifacts for 30 days.",
    relativePath: "docs/release/rollback.md",
    title: "Release rollback",
  }),
  Object.freeze({
    key: "architecture_entrypoint",
    value: "src/runtime/bootstrap.mjs",
    relativePath: "docs/architecture/overview.md",
    title: "Runtime architecture",
  }),
  Object.freeze({
    key: "secret_policy",
    value: "Never read .env files automatically.",
    relativePath: "docs/security/context.md",
    title: "Context safety",
  }),
]);

const ANSWER_PATTERN = /^BENCHMARK_ANSWER ([a-z_]+)=(.+)$/gm;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

function benchmarkError(message, detail = {}, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "LiftBenchmarkError";
  error.code = "lift-benchmark-failed";
  error.detail = detail;
  return error;
}

function positiveInteger(name, value, { minimum = 1, maximum = 10_000 } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw benchmarkError(`Invalid ${name}`, {
      option: name,
      value,
      minimum,
      maximum,
    });
  }
  return value;
}

function checkedOptions(options = {}) {
  return {
    runs: positiveInteger("runs", options.runs ?? DEFAULTS.runs, {
      maximum: 25,
    }),
    projectCount: positiveInteger(
      "projectCount",
      options.projectCount ?? DEFAULTS.projectCount,
      { minimum: 2, maximum: 500 },
    ),
    documentCount: positiveInteger(
      "documentCount",
      options.documentCount ?? DEFAULTS.documentCount,
      { minimum: QUESTIONS.length, maximum: 1_000 },
    ),
    documentBytes: positiveInteger(
      "documentBytes",
      options.documentBytes ?? DEFAULTS.documentBytes,
      { minimum: 512, maximum: 1024 * 1024 },
    ),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort((left, right) =>
      left.localeCompare(right)).map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function answerAccuracy(actual) {
  const correct = QUESTIONS.filter(({ key, value }) => actual[key] === value)
    .length;
  return {
    correct,
    total: QUESTIONS.length,
    ratio: correct / QUESTIONS.length,
  };
}

function extractAnswers(text, answers) {
  for (const match of text.matchAll(ANSWER_PATTERN)) {
    answers[match[1]] = match[2].trim();
  }
}

function recordAnswer(record, answers) {
  const answer = record?.facts?.benchmark_answer;
  if (
    answer
    && typeof answer.key === "string"
    && typeof answer.value === "string"
  ) {
    answers[answer.key] = answer.value;
  }
}

function paddedDocument(title, body, bytes) {
  const header = `# ${title}\n\n${body}\n\n`;
  if (Buffer.byteLength(header) >= bytes) return header;
  const fillerLine =
    "Operational reference material remains authoritative in this repository.\n";
  const needed = bytes - Buffer.byteLength(header);
  const repeated = fillerLine.repeat(Math.ceil(needed / fillerLine.length));
  return `${header}${repeated}`.slice(0, bytes);
}

async function writeFixtureDocuments(root, documentCount, documentBytes) {
  for (const question of QUESTIONS) {
    const file = path.join(root, question.relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      paddedDocument(
        question.title,
        `BENCHMARK_ANSWER ${question.key}=${question.value}`,
        documentBytes,
      ),
      "utf8",
    );
  }
  const referenceRoot = path.join(root, "docs", "reference");
  await fs.mkdir(referenceRoot, { recursive: true });
  for (let index = QUESTIONS.length; index < documentCount; index += 1) {
    const number = String(index).padStart(4, "0");
    await fs.writeFile(
      path.join(referenceRoot, `chapter-${number}.md`),
      paddedDocument(
        `Reference chapter ${number}`,
        [
          "This chapter discusses testing, rollback, architecture, and safety.",
          "It intentionally contains vocabulary overlap but no benchmark answer.",
        ].join("\n"),
        documentBytes,
      ),
      "utf8",
    );
  }
}

function answerRecord(projectId, question) {
  return {
    v: 1,
    id: `${projectId}:answer:${question.key}`,
    kind: "answer",
    priority: 800,
    scope: [`project:${projectId}`],
    links: [],
    topics: [question.key.replaceAll("_", " ")],
    summary: question.title,
    facts: {
      benchmark_answer: {
        key: question.key,
        value: question.value,
      },
    },
    locators: [{
      type: "file",
      path: question.relativePath,
    }],
  };
}

function decoyRecord(projectId, index) {
  return {
    v: 1,
    id: `${projectId}:answer:decoy`,
    kind: "answer",
    priority: 100,
    scope: [`project:${projectId}`],
    links: [],
    topics: ["testing", "rollback", "architecture", "safety"],
    summary: `Unrelated project ${index} benchmark decoy`,
    facts: {
      benchmark_answer: {
        key: "test_command",
        value: `do-not-leak-project-${index}`,
      },
    },
  };
}

async function buildFixture(root, options) {
  const home = path.join(root, "state");
  const activeRoot = path.join(root, "active-project");
  await Promise.all([
    fs.mkdir(path.join(home, "generations"), { recursive: true }),
    fs.mkdir(activeRoot, { recursive: true }),
  ]);
  await writeFixtureDocuments(
    activeRoot,
    options.documentCount,
    options.documentBytes,
  );

  const activeId = "p:benchmark-active";
  const projects = Array.from({ length: options.projectCount }, (_, index) => {
    const id = index === 0
      ? activeId
      : `p:benchmark-${String(index).padStart(3, "0")}`;
    return {
      id,
      name: index === 0 ? "Benchmark Active" : `Benchmark Project ${index}`,
      roots: [
        index === 0
          ? activeRoot
          : path.join(root, "offline", String(index)),
      ],
    };
  });
  const activeAnswers = QUESTIONS.filter(({ key }) => key !== "secret_policy");
  const entrypoint = {
    v: 1,
    id: `${activeId}:entrypoints`,
    kind: "index",
    priority: 900,
    required: true,
    scope: [`project:${activeId}`],
    links: [
      ...activeAnswers.map(({ key }) => `${activeId}:answer:${key}`),
      "g:benchmark:secret-policy",
    ],
    summary: "Exact routes to the benchmark answers",
  };
  const globalSecret = {
    ...answerRecord(
      activeId,
      QUESTIONS.find(({ key }) => key === "secret_policy"),
    ),
    id: "g:benchmark:secret-policy",
    priority: 1_000,
    required: true,
    scope: ["global"],
    locators: [],
  };
  const projectRecords = Object.fromEntries(projects.map((project, index) => [
    project.id,
    index === 0
      ? [
        entrypoint,
        ...activeAnswers.map((question) => answerRecord(activeId, question)),
      ]
      : [decoyRecord(project.id, index)],
  ]));
  const source = {
    catalog: { v: 1, projects },
    schema: {
      v: 1,
      record_kinds: ["answer", "index"],
    },
    globalRecords: [globalSecret],
    projectRecords,
  };
  const generation = await buildGeneration({
    home,
    source,
    indexBuilder: (id, persisted) => buildIndexes({
      generation: id,
      catalog: persisted.catalog,
      globalRecords: persisted.globalRecords,
      projectRecords: persisted.projectRecords,
    }),
  });
  await promoteGeneration({ home, generation });
  return { home, activeRoot, activeId };
}

async function repositoryFiles(root) {
  const found = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(target);
      } else if (entry.isFile() && entry.name !== ".env") {
        found.push(target);
      }
    }
  }
  await visit(root);
  return found;
}

async function runBroadRepositoryControl(root) {
  const startedAt = performance.now();
  const files = await repositoryFiles(root);
  const answers = {};
  let bytesRead = 0;
  for (const file of files) {
    const contents = await fs.readFile(file, "utf8");
    bytesRead += Buffer.byteLength(contents);
    extractAnswers(contents, answers);
  }
  const elapsedMs = performance.now() - startedAt;
  return {
    method: "broad-repository-scan",
    answers,
    accuracy: answerAccuracy(answers),
    files_inspected: files.length,
    read_operations: files.length,
    bytes_inspected: bytesRead,
    evidence_bytes: Buffer.byteLength(stableJson(answers)),
    broad_search_used: true,
    elapsed_ms: elapsedMs,
    deterministic_hash: hash(answers),
  };
}

function trackedFilesystem() {
  const observations = [];
  return {
    fsApi: {
      ...fs,
      async readFile(file, encoding) {
        const value = await fs.readFile(file, encoding);
        observations.push({
          file: path.resolve(file),
          bytes: Buffer.byteLength(value),
        });
        return value;
      },
    },
    metrics() {
      return {
        files_inspected: new Set(observations.map(({ file }) => file)).size,
        read_operations: observations.length,
        bytes_inspected: observations.reduce(
          (total, observation) => total + observation.bytes,
          0,
        ),
      };
    },
  };
}

async function runLodestarTrial({ home, activeRoot, activeId }) {
  const tracker = trackedFilesystem();
  const startedAt = performance.now();
  const store = await ContextStore.open({
    home,
    cwd: activeRoot,
    fsApi: tracker.fsApi,
  });
  const startup = await store.start();
  const resolved = await store.resolve(`${activeId}:entrypoints`);
  const elapsedMs = performance.now() - startedAt;
  const answers = {};
  for (const record of [...startup.required, ...resolved.records]) {
    recordAnswer(record, answers);
  }
  const unrelatedRecords = resolved.records.filter((record) =>
    record.id.startsWith("p:benchmark-")
    && !record.id.startsWith(`${activeId}:`));
  const response = { startup, resolved };
  return {
    method: "lodestar-start-plus-resolve",
    answers,
    accuracy: answerAccuracy(answers),
    ...tracker.metrics(),
    evidence_bytes: Buffer.byteLength(stableJson(response)),
    broad_search_used: false,
    unrelated_records: unrelatedRecords.map(({ id }) => id),
    elapsed_ms: elapsedMs,
    deterministic_hash: hash(response),
  };
}

function summarizeRuns(runs) {
  const representative = runs.at(-1);
  return {
    ...representative,
    elapsed_ms: Number(median(runs.map(({ elapsed_ms: value }) => value))
      .toFixed(3)),
    elapsed_samples_ms: runs.map(({ elapsed_ms: value }) =>
      Number(value.toFixed(3))),
  };
}

function reduction(smaller, larger) {
  if (larger === 0) return null;
  return Number(((1 - smaller / larger) * 100).toFixed(2));
}

export async function withLiftBenchmarkFixture(rawOptions = {}, run) {
  if (typeof run !== "function") {
    throw benchmarkError("Benchmark fixture callback is required");
  }
  const options = checkedOptions(rawOptions);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lodestar-lift-"));
  try {
    const fixture = await buildFixture(root, options);
    return await run({ fixture, options });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function runLiftBenchmark(rawOptions = {}) {
  try {
    return await withLiftBenchmarkFixture(rawOptions, async ({
      fixture,
      options,
    }) => {
      const broadRuns = [];
      const lodestarRuns = [];
      for (let index = 0; index < options.runs; index += 1) {
        broadRuns.push(await runBroadRepositoryControl(fixture.activeRoot));
        lodestarRuns.push(await runLodestarTrial(fixture));
      }
      const broad = summarizeRuns(broadRuns);
      const lodestar = summarizeRuns(lodestarRuns);
      const lodestarHashes = new Set(
        lodestarRuns.map(({ deterministic_hash: value }) => value),
      );
      const gates = {
        answer_parity:
          lodestar.accuracy.ratio === 1 && broad.accuracy.ratio === 1,
        deterministic_lodestar: lodestarHashes.size === 1,
        fewer_files_inspected:
          lodestar.files_inspected < broad.files_inspected,
        fewer_bytes_inspected:
          lodestar.bytes_inspected < broad.bytes_inspected,
        no_broad_search: lodestar.broad_search_used === false,
        no_cross_project_records: lodestar.unrelated_records.length === 0,
      };
      return {
        v: 1,
        benchmark: "lodestar-paired-retrieval-lift",
        methodology:
          "deterministic synthetic retrieval; not a language-model quality claim",
        fixture: {
          projects: options.projectCount,
          repository_documents: options.documentCount,
          target_document_bytes: options.documentBytes,
          questions: QUESTIONS.length,
          warm_runs: options.runs,
        },
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        results: {
          without_lodestar: broad,
          with_lodestar: lodestar,
        },
        lift: {
          file_reduction_percent: reduction(
            lodestar.files_inspected,
            broad.files_inspected,
          ),
          inspected_byte_reduction_percent: reduction(
            lodestar.bytes_inspected,
            broad.bytes_inspected,
          ),
          evidence_byte_reduction_percent: reduction(
            lodestar.evidence_bytes,
            broad.evidence_bytes,
          ),
          median_time_reduction_percent: reduction(
            lodestar.elapsed_ms,
            broad.elapsed_ms,
          ),
        },
        gates,
        passed: Object.values(gates).every(Boolean),
      };
    });
  } catch (error) {
    if (error?.code === "lift-benchmark-failed") throw error;
    throw benchmarkError(
      "Unable to complete the paired lift benchmark",
      {},
      error,
    );
  }
}

export const LIFT_BENCHMARK_DEFAULTS = DEFAULTS;
