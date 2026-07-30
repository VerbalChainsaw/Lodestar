# Measuring Lodestar's Material Lift

Lodestar includes a paired, automated retrieval benchmark:

```bash
npm run benchmark:lift
```

For machine-readable evidence:

```bash
npm run benchmark:lift -- --json
```

## What the benchmark compares

Both paths receive the same synthetic repository, the same four questions, and
the same authoritative answers.

- **Without Lodestar:** a deterministic control recursively inspects the active
  repository's eligible files and extracts the answers. It represents a
  successful broad repository-discovery pass.
- **With Lodestar:** the real `ContextStore` opens the same 100-project
  catalog, runs `start`, follows the active project's exact entrypoint with
  `resolve`, and extracts the structured answers.

The fixture deliberately includes overlapping vocabulary and records for 99
unrelated projects. Lodestar must not return any of those records.

The benchmark records:

- answer correctness;
- unique files and total read operations;
- bytes inspected from storage;
- bytes in the returned evidence packet;
- whether broad repository search was required;
- cross-project record leakage;
- deterministic output hashes;
- median local elapsed time over repeated warm runs.

## Pass/fail contract

The benchmark passes only when:

1. both paths answer every fixture question correctly;
2. repeated Lodestar results are byte-deterministic;
3. Lodestar inspects fewer files and fewer bytes;
4. Lodestar does not use broad repository search; and
5. Lodestar returns zero unrelated-project records.

Elapsed time and returned-evidence size are reported but are not pass/fail
gates. Timing varies by filesystem, cache state, antivirus software, and
machine load. A compact structured packet can also be larger than four
artificially perfect answer lines while still avoiding far more filesystem
inspection. The report keeps those outcomes visible instead of hiding an
unfavorable number.

## What this does not prove

This is a deterministic **retrieval-efficiency** benchmark. It proves the
mechanical difference between broad discovery and Lodestar's linked, scoped
retrieval path. It does not claim that every language model will produce a
better final answer.

A live-agent A/B evaluation is a separate experiment: run the same task corpus
across repeated fresh agent sessions, randomly assign Lodestar availability,
pin the model and tool policy, and score blinded transcripts. That experiment
is valuable, but it is nondeterministic, credentialed, and potentially costly,
so it is not part of the zero-dependency release gate.

## Fixture controls

The defaults are versioned in `lib/lift-benchmark.mjs`. They can be varied
without editing source:

```bash
node tools/benchmark-lift.mjs \
  --runs 9 \
  --projects 150 \
  --documents 96 \
  --document-bytes 32768
```

Keep published comparisons on identical fixture parameters and report the
Node.js version, platform, and architecture included in the JSON result.
