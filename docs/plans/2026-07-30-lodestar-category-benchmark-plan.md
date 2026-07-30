# Lodestar Category Benchmark Plan

**Date:** 2026-07-30  
**Status:** Harness implemented; paid pilot pending  
**Product distinction:** Lodestar-enabled vs. unmanaged agent context

## 1. Purpose

This benchmark tests Lodestar as an agent operating substrate, not merely as a
fast local lookup command.

The central question is:

> Does Lodestar make an ordinary coding agent more likely to reach the correct
> repository answer with less search, less transferred context, fewer wrong
> turns, better scope discipline, and more reproducible behavior?

The benchmark compares fresh agent sessions on paired copies of the same
repository fixture:

- **Unmanaged agent context:** repository access plus ordinary repository
  instructions.
- **Lodestar-enabled:** the same repository and instructions plus the Lodestar
  bootstrap contract and a valid linked context store.

The intended public claim is not “Lodestar always wins.” The benchmark must
identify neutral cases, losses, setup cost, maintenance cost, stale-context
failure modes, and the crossover point where deterministic context becomes
materially useful.

## 2. Category Thesis

Lodestar aims to establish a binary operating distinction:

```text
Lodestar-enabled
vs.
unmanaged agent context
```

A Lodestar-enabled repository gives an agent:

- deterministic project identity before action;
- one bounded startup packet;
- explicit behavior and scope rules;
- stable routes to commands, constraints, decisions, and documentation;
- exact linked retrieval before broad search;
- an actionable context-miss path when structured knowledge is insufficient.

The category claim is:

> Lodestar turns an unstructured repository into an agent-legible operating
> environment.

The benchmark exists to determine when that claim is true, how large the lift
is, and where it stops being true.

## 3. Registered Hypotheses

The paid evaluation will register these hypotheses before model execution:

1. Lodestar is non-inferior on answer correctness across the full corpus.
2. Lodestar improves correctness in repositories with stale, conflicting, or
   distributed operational knowledge.
3. Lodestar reduces tool calls, unique files, inspected bytes, broad searches,
   and wrong turns in ambiguity-heavy repositories.
4. Lodestar improves reproducibility across repeated fresh sessions.
5. Lodestar prevents cross-project leakage when multiple projects reuse the
   same names and vocabulary.
6. Lodestar improves confidence calibration by making known answers and
   context misses explicit.
7. Direct inspection is competitive or faster in tiny, unambiguous
   repositories.
8. Stale curated context can make Lodestar worse until `refresh`, `doctor`, or
   curation repairs it.
9. Lodestar's advantage rises with repository size, ambiguity, project count,
   and repeated agent-session frequency.

Hypotheses 7 and 8 are intentional losing-case hypotheses. Removing them would
turn the suite into benchmark perfume.

## 4. Fixture Design

### 4.1 Required ambiguity

The realistic fixture contains:

- active and abandoned plans;
- stale documentation;
- root and nested instruction files;
- conflicting test and service commands;
- old and current migrations;
- authoritative and superseded implementations;
- accepted and superseded decisions;
- generated artifacts that look editable;
- hidden-but-reachable authoritative sources;
- overlapping terminology;
- a sibling project with the same paths and a unique leakage canary.

The ground-truth rubric lives outside the agent's workspace. Neither condition
can inspect its expected answers.

### 4.2 Scenario families

#### Tiny direct

A five-file repository with little ambiguity. It establishes the lower bound
and makes neutral or losing Lodestar results publishable.

#### Ambiguous repository

The full fixture with stale plans, conflicting commands, generated output,
nested instructions, and cross-project traps. This is the primary material-lift
scenario.

#### Stale Lodestar

The repository has changed after context curation. At least one Lodestar record
is deliberately stale while the repository contains the current truth. This
tests whether structured context can mislead an agent and measures the cost of
maintenance failure.

### 4.3 Future scale bands

After the pilot validates the harness, add generated scale bands while retaining
the same semantic tasks:

| Band | Active files | Cataloged projects | Ambiguity |
| --- | ---: | ---: | --- |
| Tiny | 5 | 1 | Low |
| Small | 25 | 3 | Low to medium |
| Medium | 250 | 20 | Medium |
| Large | 2,500 | 100 | High |

These bands support crossover analysis. File count alone is not sufficient;
instruction ambiguity and repeated project vocabulary must vary independently.

## 5. Engineering Questions

The first registered question suite asks:

1. How do I test this project?
2. Which migration is current?
3. What command starts the service?
4. Which implementation is authoritative?
5. What decision governs this subsystem?
6. What file should be changed?
7. What is unsafe to modify?

Each question has:

- an exact accepted answer;
- one or more authoritative evidence paths;
- known decoy paths;
- forbidden cross-project canaries;
- a deterministic scoring rule;
- a semantic-review flag when exact matching is insufficient.

Production expansion should add tasks about release procedures, environment
requirements, ownership, rollback, incompatible changes, and explicit context
misses.

## 6. Trial Protocol

Each model/question/condition/repetition is a fresh isolated trial.

1. Build a new fixture workspace.
2. Place the leakage trap outside the active repository but inside the trial
   sandbox.
3. Apply ordinary instructions to both conditions.
4. Add only the managed Lodestar block and state home to the Lodestar condition.
5. Start a fresh ephemeral agent session in read-only mode.
6. Ask exactly one registered question.
7. Require a structured answer, confidence from 0 to 1, and repository-relative
   evidence paths.
8. Capture the complete adapter response, normalized tool events, usage, timing,
   and final answer.
9. Score deterministically, retaining ambiguous cases for blinded review.
10. Destroy the workspace unless diagnostic retention was explicitly enabled.

Trial order is deterministically randomized from a recorded seed. Conditions
are paired within model, scenario, question, and repetition.

## 7. Metrics

### 7.1 Primary outcomes

- answer correctness;
- authoritative evidence correctness;
- time to completed answer;
- model input, cached-input, reasoning, and output tokens;
- successful-answer cost;
- tool calls;
- unique files inspected;
- bytes observed where the adapter exposes them;
- broad repository searches;
- wrong turns through known decoys;
- cross-project leakage;
- Lodestar protocol compliance.

### 7.2 Reliability outcomes

- normalized answer-hash reproducibility;
- failure and timeout rates;
- evidence agreement across repetitions;
- confidence calibration;
- Brier score;
- context-miss accuracy;
- stale-context detection.

### 7.3 Operational costs

- one-time setup time;
- curation time;
- refresh and doctor time;
- context maintenance actions per repository change;
- amortized cost across agent sessions;
- direct-inspection crossover point.

Adapter trace fidelity must accompany every published metric. A provider that
does not expose file bytes cannot be presented as if it did.
For the included Codex adapter, observed bytes are shell-tool output transferred
back into the agent session, not filesystem bytes physically read.

## 8. Analysis

Report raw condition summaries and paired deltas by:

- model;
- scenario;
- question;
- repetition;
- repository scale and ambiguity band.

Primary correctness treats failed and timed-out trials as not correct. Also
report correctness conditional on receiving a completed answer so model failure
and answer quality remain distinguishable.

Use:

- correctness proportions with paired confidence intervals;
- median and p95 latency/tool/file/byte outcomes;
- paired effect sizes;
- bootstrap intervals for median deltas;
- Brier score and reliability diagrams for confidence;
- failure-inclusive cost per correct answer;
- reproducibility as the dominant normalized-answer share within repeated
  cells.

The production report must distinguish:

- statistical uncertainty;
- measurement absence;
- model failure;
- harness failure;
- genuine context failure.

Do not replace effect sizes with p-value theater. A small statistically
detectable difference may still be operationally meaningless.

## 9. Crossover Point

The benchmark should eventually support a statement such as:

> Below five small files, Lodestar provides little measurable speed advantage.
> Its value rises with repository scale, instruction ambiguity, project count,
> and agent-session frequency.

That sentence is a hypothesis until the scale matrix is run. Determine the
crossover using a response surface across:

- active file count;
- operational-answer dispersion;
- number of conflicting sources;
- cataloged project count;
- number of repeated sessions;
- setup and maintenance minutes.

Publish the band where the confidence interval crosses zero, not merely the
best observed point.

## 10. Cost and Safety Controls

The harness is non-spending by default.

- Running the command without `--execute` only prints the trial plan.
- Every enabled runner declares a user-supplied estimated maximum cost per
  trial.
- Execution requires an explicit absolute output directory.
- Execution requires `--max-cost-usd`.
- The selected trial estimate must fit under that cap.
- `--max-trials` supports small pilots.
- Every trial has a timeout.
- No retry occurs implicitly.
- Creating `<output>/STOP` halts before the next trial.
- Completed trials resume from JSONL without being purchased twice.
- Credentials remain in the provider CLI or runner environment and are never
  written into the manifest.
- Raw artifacts remain local until manually inspected for publication.

Cost estimates are planning ceilings, not provider invoices. The report must
state whether actual cost was exposed by the runner.

## 11. Provider-Neutral Runner Contract

The harness sends one JSON request to a runner's stdin. The request includes:

- trial and runner IDs;
- condition and scenario;
- one question;
- active repository path;
- read-only and scope constraints;
- the Lodestar home and exact bootstrap command only in the Lodestar condition.

The runner returns one JSON object:

```json
{
  "v": 1,
  "trial_id": "<same-id>",
  "status": "completed",
  "answer": {
    "answer": "npm run verify:ci",
    "confidence": 0.92,
    "evidence": ["docs/operations/testing-current.md"],
    "explanation": "The current operations document supersedes the README."
  },
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 85
  },
  "events": [
    {
      "type": "tool",
      "tool": "shell",
      "action": "exec",
      "command": "agentctx start --cwd ...",
      "paths": [],
      "bytes": 2048,
      "broad": false
    }
  ]
}
```

The harness captures runner stdout and diagnostics itself. Adapters may include
raw provider events, which are retained outside normalized results.

The first real adapter uses `codex exec --json --ephemeral`, a read-only
sandbox, a restricted tool environment, a JSON output schema, and an isolated
`CODEX_HOME`. Isolation prevents machine-level `AGENTS.md` or configuration
from making the unmanaged condition secretly Lodestar-aware. It requires
invocation-scoped API authentication. An explicit user-context mode exists for
local smoke tests but is marked non-publishable. Other models can implement the
same stdin/stdout contract without changing the fixture or scorer.

## 12. Publication Rules

Every public benchmark release must include:

- the Lodestar and harness commit;
- fixture fingerprint;
- complete configuration;
- model/provider identifiers and relevant settings;
- repetition count and randomized seed;
- platform, architecture, Node version, and runner version;
- all failures and timeouts;
- raw normalized results;
- unfavorable and neutral cases;
- setup and maintenance measurements;
- limitations and missing telemetry;
- the scoring rubric;
- a privacy-reviewed transcript archive or an explicit reason it cannot be
  published.

Never:

- drop failed trials after purchase;
- compare different questions or permissions across conditions;
- give Lodestar exclusive information outside its declared context store;
- hide stale-context losses;
- report bytes when the adapter did not expose bytes;
- select only winning models, tasks, or repetitions;
- describe a deterministic mock-runner result as model evidence.

## 13. Execution Phases

### Phase 0 — deterministic harness validation

- Run all harness tests with the mock adapter.
- Verify a known stale-Lodestar loss remains visible.
- Verify resume, STOP, timeout, malformed output, cost cap, and leakage scoring.

### Phase 1 — paid pilot

- Two or three models.
- All three scenarios.
- One or two repetitions.
- Explicit cost ceiling.
- Manual inspection of every transcript.
- Repair measurement defects, not unfavorable outcomes.

### Phase 2 — registered production run

- Freeze the fixture fingerprint and scoring rubric.
- Use three to five representative models.
- Use at least three repetitions per paired cell.
- Add small, medium, and large scale bands.
- Run Windows and WSL separately where tool telemetry differs.

### Phase 3 — public benchmark report

- Publish the full result bundle.
- State the category claim the data supports.
- State the crossover point.
- State where unmanaged context is sufficient or superior.
- Version the benchmark so future Lodestar releases cannot silently change the
  test in their favor.

## 14. Acceptance Criteria

The harness is ready for a paid pilot when:

1. its default path starts no model process;
2. every execution has an explicit cost and trial cap;
3. fixture generation is deterministic and ground truth is unavailable to the
   agent;
4. conditions are paired and trial order is reproducible;
5. raw events, normalized events, usage, answers, errors, and scores are
   retained;
6. failures, timeouts, leakage, and stale-context losses remain in summaries;
7. resume cannot repurchase completed trial IDs;
8. the Codex adapter runs read-only and emits schema-validated answers;
9. Windows, WSL/Linux, and macOS tests pass;
10. the methodology and limitations ship with the package.

## 15. Deliverables

- Plan:
  `docs/plans/2026-07-30-lodestar-category-benchmark-plan.md`
- Public method:
  `docs/category-benchmark.md`
- Harness:
  `tools/benchmark-category.mjs`
- Provider-neutral orchestration:
  `lib/category-harness.mjs`
- Fixture and hidden scorer:
  `lib/category-fixture.mjs`, `lib/category-score.mjs`
- Codex adapter:
  `tools/category-codex-runner.mjs`
- Protocol self-test adapter:
  `tools/category-mock-runner.mjs`
- Example paid-run configuration:
  `benchmarks/category/config.example.json`
- Structured-answer schema:
  `schema/category-benchmark-answer.json`
