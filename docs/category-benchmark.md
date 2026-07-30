# The Lodestar Category Benchmark

The category benchmark compares **Lodestar-enabled** repositories with
**unmanaged agent context** using fresh, paired model sessions.

It is the live-agent complement to Lodestar's deterministic retrieval and
performance suites:

```bash
npm run benchmark:lift
npm run benchmark:performance
npm run benchmark:category -- --config benchmarks/category/config.example.json
```

The third command is a dry run. It prints the exact trial count, randomized
plan, fixture fingerprint, and user-estimated maximum cost without starting a
model process.

## What it tests

The fixture includes current and abandoned plans, stale documentation,
conflicting commands, multiple instruction files, old and authoritative
implementations, generated artifacts, and an unrelated sibling project with a
leakage canary.

The first question set asks:

- How do I test this project?
- Which migration is current?
- What command starts the service?
- Which implementation is authoritative?
- What decision governs this subsystem?
- What file should be changed?
- What is unsafe to modify?

Three scenario families prevent one-sided reporting:

- `tiny-direct`, where direct inspection may be just as good or faster;
- `ambiguous-repository`, where context routing should have the greatest value;
- `stale-lodestar`, where structured context is deliberately behind repository
  truth and may lose.

## Metrics

The harness records correctness, evidence correctness, elapsed time, tokens,
tool calls, unique files, observed bytes, broad searches, known wrong turns,
cross-project leakage, Lodestar protocol compliance, answer reproducibility,
confidence, and Brier score.

Protocol compliance requires a Lodestar condition's first tool action to be
`start`. Quoted executable paths and shell-wrapped `agentctx` commands are
recognized; exact reads without the required bootstrap do not pass.

Metrics depend on adapter telemetry. If a provider does not expose file bytes
or token usage, those values must be reported as unavailable rather than
inferred. The Codex adapter's byte metric is shell-tool output transferred back
to the agent, not physical disk bytes read.

## Safe dry run

Copy the example config and set a conservative per-trial estimate for each
runner. The estimate is your planning ceiling; it is not a pricing claim by
Lodestar.

```bash
cp benchmarks/category/config.example.json /tmp/lodestar-category.json
npm run benchmark:category -- --config /tmp/lodestar-category.json
```

The example's full matrix currently contains 48 trials:

```text
1 runner
× 12 registered questions across scenario families
× 2 conditions
× 2 repetitions
= 48 trials
```

Changing models, repetitions, or scenarios changes the plan deterministically.

## Paid execution

Execution requires three separate signals:

```bash
npm run benchmark:category -- \
  --config /absolute/path/category.json \
  --execute \
  --output /absolute/path/category-results \
  --max-cost-usd 24
```

Use `--max-trials 4` for a small smoke pilot. Add `--keep-workspaces` only when
debugging; ordinary runs retain requests, responses, normalized results, and
summaries while deleting trial repositories.

Create an empty `STOP` file in the output directory to stop before the next
trial:

```bash
touch /absolute/path/category-results/STOP
```

Re-running the same plan and output directory resumes from recorded trial IDs.
It does not purchase completed trials again.

## Runners

The harness is provider-neutral. It sends one v1 JSON request to the configured
command's stdin and expects one v1 JSON response on stdout.

The included Codex adapter uses the Codex CLI. Publishable runs isolate
`CODEX_HOME` so machine-level instructions cannot contaminate either condition
and require `CODEX_API_KEY` in the invocation environment:

```json
{
  "id": "codex-default",
  "enabled": true,
  "command": [
    "{node}",
    "{packageRoot}/tools/category-codex-runner.mjs"
  ],
  "estimated_cost_usd_per_trial": 0.5
}
```

To pin a model and reasoning effort, add adapter arguments:

```json
{
  "id": "codex-model-a",
  "enabled": true,
  "command": [
    "{node}",
    "{packageRoot}/tools/category-codex-runner.mjs",
    "--model",
    "<model-id>",
    "--reasoning-effort",
    "medium"
  ],
  "estimated_cost_usd_per_trial": 0.5
}
```

The adapter runs `codex exec --json --ephemeral` with a read-only sandbox, a
restricted tool environment, and a required output schema. The API key is used
by the Codex parent process but excluded from model-launched shell commands.
Lodestar does not read or save it.

For a local adapter smoke test using existing Codex authentication, append
`--allow-user-context` to the runner command. That mode may inherit machine
instructions, is labeled in adapter diagnostics, and is not valid for a
published condition comparison.

Other provider adapters can implement the same JSON protocol. Do not put API
keys in the benchmark config.

## Artifacts

The output directory contains:

```text
manifest.json
results.jsonl
summary.json
raw/
  <trial>.request.json
  <trial>.response.json
work/
```

`results.jsonl` omits bulky raw provider events. The raw response artifact
retains them for audit. Inspect every raw artifact for private machine details
before publishing it.

## Interpretation

The mock runner exists only to prove the harness, scorer, cost boundary, and
failure paths. It is not model evidence.

The live-agent benchmark is nondeterministic. Report paired distributions,
failures, effect sizes, and confidence intervals. Publish neutral and losing
cases. Do not claim that a missing telemetry field is zero.

The full preregistration and publication rules are in
[`docs/plans/2026-07-30-lodestar-category-benchmark-plan.md`](plans/2026-07-30-lodestar-category-benchmark-plan.md).
