# Lodestar Benchmarks

Lodestar is designed to reduce environmental work around coding-agent reasoning: less repository inspection, less context transfer, deterministic routing, and strict project isolation.

The benchmark suites are intentionally separated into two questions:

1. **Material lift:** Can Lodestar preserve answer correctness while reducing the amount of repository material an agent must inspect?
2. **Runtime overhead:** How quickly does Lodestar start, retrieve exact records, resolve linked context, and search its bounded index as the project catalog grows?

## Headline results

### Material-lift benchmark

The paired benchmark asks the same four repository questions with and without Lodestar.

| Metric | Without Lodestar | With Lodestar |
| --- | ---: | ---: |
| Correct answers | 4/4 | 4/4 |
| Files inspected | 64 | 6 |
| Bytes inspected | 1.0 MiB | 24–28 KiB |
| Broad search | Yes | No |
| Cross-project leakage | N/A | 0 |
| Median time improvement | — | 24–27% |

That is approximately **90.6% fewer files inspected** and **97% fewer bytes inspected** on both Windows and WSL, while preserving the measured 4/4 answer correctness.

### Scale profiles

| Profile | WSL, without → with Lodestar | Windows, without → with Lodestar | Bytes saved |
| --- | ---: | ---: | ---: |
| 10 projects | 4.39 → 3.15 ms | 5.57 → 4.44 ms | 92% |
| 100 projects | 17.69 → 10.72 ms | 21.82 → 14.63 ms | 97% |
| 500 projects | 75.45 → 46.47 ms | 93.89 → 65.88 ms | 98% |

The reduction grows with catalog size: the larger and noisier the environment, the more repository inspection Lodestar avoids.

### Operation-level p50

| Operation | WSL | Windows |
| --- | ---: | ---: |
| Fresh-store startup | 9.86 ms | 14.44 ms |
| Warm startup | 0.037 ms | 0.048 ms |
| Exact `get` | 0.010 ms | 0.013 ms |
| Linked `resolve` | 0.059 ms | 0.081 ms |
| Indexed `find` | 0.483 ms | 0.737 ms |
| 16 parallel exact reads | 0.151 ms | 0.175 ms |

The suite also records p95, minimum, maximum, arithmetic mean, memory snapshots, machine-readable JSON, and fresh-versus-warm behavior.

## Reproduce the results

Run the paired material-lift benchmark:

```bash
npm run benchmark:lift
```

Run the extended scale and operation-level suite:

```bash
npm run benchmark:performance
```

Use the quick profile while developing:

```bash
npm run benchmark:performance -- --quick
```

Emit machine-readable results:

```bash
npm run benchmark:performance -- --json
```

Installed packages also expose the public `lodestar-benchmark` and `lodestar-performance` commands.

## Regression coverage

At the time of this snapshot:

- WSL/Linux: 158/158 tests pass.
- Native Windows runs the same suite with one expected platform-specific
  symlink skip.
- Real tarball installation and npm binary execution pass.
- JSON consumers and structured invalid-option behavior pass.
- Hosted Windows, Ubuntu, and macOS CI pass.

## v0.5 project-readiness regression snapshot

The v0.5 implementation was measured before and after the registry-merge and
readiness changes on the same WSL machine, Node.js v22.22.3, 100-project
fixture, 10 warmups, and 75 timed samples:

| Operation | Before p50 | After p50 |
| --- | ---: | ---: |
| Fresh-store startup | 11.007 ms | 9.782 ms |
| Warm startup | 0.041 ms | 0.046 ms |
| Exact `get` | 0.011 ms | 0.010 ms |
| Linked `resolve` | 0.060 ms | 0.059 ms |
| Indexed `find` | 0.553 ms | 0.509 ms |
| 16 parallel exact reads | 0.154 ms | 0.149 ms |

The material-lift fixture still passed all correctness, determinism, scope, and
transfer gates: 4/4 answers on both paths, 64 versus 6 files, 1 MiB versus
24,923 bytes, no broad search, zero cross-project records, and a 37.32% median
elapsed-time improvement in that run.

The actual 67-project registry preview also completed without mutation in a
318.941 ms p50 over 10 warm samples on the same WSL filesystem. Registry import
is an administrative full-store transaction, not part of agent startup.

The quick tiny-repository fixture remains an honest losing case on elapsed
time: broad inspection can be faster when only eight 1 KiB documents exist.
Lodestar still wins that fixture on scope, determinism, file count, and bytes,
but its material speed advantage begins as repository ambiguity and scale grow.

## What these results prove

The current suites provide evidence for:

- retrieval efficiency;
- deterministic behavior;
- project-scope isolation;
- bounded runtime overhead;
- correct installed-package wiring; and
- scale behavior through 500 projects.

They do **not** claim universal improvement in LLM answer quality. The structured evidence packet is deliberately richer than four artificially perfect answer lines, and live-agent quality remains a separate controlled A/B evaluation.

## Interpretation limits

“Fresh store” does not mean cold disk. It creates a new `ContextStore`, but the process and operating-system filesystem caches remain intact. True cold-disk measurements would require unsafe or platform-specific cache flushing and would be difficult to reproduce.

Timing and memory measurements vary with hardware, antivirus scanning, WSL filesystem placement, operating-system cache state, background load, garbage collection, and power policy. Compare identical fixtures on the same machine and retain unfavorable measurements rather than selecting only winning runs.

For detailed fixture definitions and reporting rules, see [performance.md](performance.md). For the paired evaluation design, see [evaluation.md](evaluation.md).
