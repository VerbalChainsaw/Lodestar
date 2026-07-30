# Lodestar Benchmarks

Lodestar is designed to reduce environmental work around coding-agent reasoning: less repository inspection, less context transfer, deterministic routing, and strict project isolation.

The benchmark suites are intentionally separated into two questions:

1. **Material lift:** Can Lodestar preserve answer correctness while reducing the amount of repository material an agent must inspect?
2. **Runtime overhead:** How quickly does Lodestar start, retrieve exact records, resolve linked context, and search its bounded index as the project catalog grows?

## v0.7.0 payload/payback release

The v0.7.0 release candidate was measured on 2026-07-30. The real 71-project
canonical startup packet fell from 16,300 to 4,879 bytes, a 70.1% reduction,
while retaining all six required records and explicitly reporting omitted
optional IDs.

The final fresh 10/100/500-project performance run passed every correctness,
determinism, scope, broad-search, inspected-byte, and 5 KiB startup-payload
gate. Median elapsed-time reductions were 35.51%, 34.39%, and 33.62%,
respectively. The synthetic fixture's startup packet was 1,482 bytes in every
scale profile.

At 100 projects, Lodestar avoided 1,023,653 inspected bytes while adding 3,234
evidence bytes and saving 5.305 ms at the median. At 500 projects, it avoided
8,274,085 inspected bytes and saved 21.045 ms. These are measured work
observations, not inferred token or dollar savings.

An immediate three-run comparison against commit `6851f9c` measured these
operation p50 medians on the same machine:

| Operation | `6851f9c` | v0.7.0 |
| --- | ---: | ---: |
| Fresh-store startup | 11.593 ms | 10.842 ms |
| Warm startup | 0.050 ms | 0.047 ms |
| Exact `get` | 0.013 ms | 0.016 ms |
| Linked `resolve` | 0.073 ms | 0.072 ms |
| Indexed `find` | 0.639 ms | 0.628 ms |
| 16 parallel exact reads | 0.208 ms | 0.197 ms |

The 0.003 ms exact-read difference is below a material user-visible threshold;
the changed startup path was faster in the paired code comparison.

The deliberately tiny 25-run controls remain losing elapsed-time cases.
Lodestar avoided 3,249 bytes but added 0.553 ms at 10 projects/8 KiB, and
avoided 7,845 bytes but added 7.183 ms at 100 projects/32 KiB. Those results
define where direct inspection is cheaper and remain visible.

The smallest authenticated local Codex smoke was also run under explicit
trial/cost caps. It is **not publishable evidence** because invocation-scoped
credentials were unavailable and the adapter inherited user context. After a
scorer compatibility fix and a no-refetch instruction, one paired ambiguous-
repository question produced:

| Metric | Unmanaged | Lodestar |
| --- | ---: | ---: |
| Correct answer and evidence | 1/1 | 1/1 |
| Tool calls | 3 | 3 |
| Unique repository files | 6 | 1 |
| Broad search / leakage | 0 / 0 | 0 / 0 |
| Elapsed time | 19.479 s | 23.064 s |
| Reported input tokens | 69,535 | 71,821 |

This smoke validates the lean command path and a five-file focus improvement,
but it does not prove live-agent payback: Lodestar added 3.585 seconds and
2,286 reported input tokens in the single contaminated pair. A randomized,
repeated, invocation-isolated run is still required before making a
provider-level economic claim.

### Deep-audit optimization

The same 55-generation Windows-backed canonical store was audited before and
after bounded-concurrent generation inspection. Deep doctor fell from 48.87
seconds to 18.74 seconds, a 61.7% code-level reduction, with deterministic
issue ordering and the same integrity findings. After a verified snapshot,
71-project refresh, locator repair, and recoverable retention maintenance, the
canonical store retained one active sealed generation and deep doctor completed
in 3.75 seconds with zero issues—a 92.3% end-to-end reduction.

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
| Median time improvement | — | 34.39% in the fresh v0.7.0 WSL run |

That is approximately **90.6% fewer files inspected** and **97% fewer bytes
inspected** on both Windows and WSL, while preserving the measured 4/4 answer
correctness. The fresh v0.7.0 WSL release run measured a 34.39% median elapsed
time improvement.

### Scale profiles

| Profile | WSL, without → with Lodestar | Windows, without → with Lodestar | Bytes saved |
| --- | ---: | ---: | ---: |
| 10 projects | 4.361 → 2.901 ms | 5.57 → 4.44 ms | 92% |
| 100 projects | 15.595 → 10.261 ms | 21.82 → 14.63 ms | 97% |
| 500 projects | 63.934 → 42.664 ms | 93.89 → 65.88 ms | 98% |

The reduction grows with catalog size: the larger and noisier the environment, the more repository inspection Lodestar avoids.

### Small-fixture boundary

The same benchmark was rerun for 25 samples on deliberately tiny fixtures:

| Fixture | Without Lodestar | With Lodestar | Files | Bytes |
| --- | ---: | ---: | ---: | ---: |
| 10 projects, 8 × 1 KiB docs | 2.806 ms | 3.334 ms | 8 → 6 | 8,192 → 4,943 |
| 100 projects, 16 × 2 KiB docs | 4.753 ms | 11.334 ms | 16 → 6 | 32,768 → 24,923 |

Lodestar was 18.82% and 138.46% slower at the median in those cases. It still
passed correctness, determinism, isolation, broad-search, file, and inspected-
byte gates. This is the expected fixed-cost boundary: a tiny, direct repository
can be faster to scan, while Lodestar's retrieval advantage grows as repository
material and ambiguity increase.

### Operation-level p50

| Operation | WSL | Windows |
| --- | ---: | ---: |
| Fresh-store startup | 9.537 ms | 14.44 ms |
| Warm startup | 0.048 ms | 0.048 ms |
| Exact `get` | 0.012 ms | 0.013 ms |
| Linked `resolve` | 0.070 ms | 0.081 ms |
| Indexed `find` | 0.509 ms | 0.737 ms |
| 16 parallel exact reads | 0.186 ms | 0.175 ms |

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

At the v0.7.0 release candidate:

- WSL/Linux: 204/204 substantive tests pass with no skips.
- The prior v0.6.1 native-Windows baseline was 198 pass, 0 fail, with three
  intentional platform-specific skips; the tagged v0.7.0 workflow must earn a
  new result before publication.
- The packed release candidate passes isolated installation, installed-binary
  startup, deep doctor, snapshot creation and verification, restore,
  restored-store deep doctor, and maintenance preview.
- JSON consumers and structured invalid-option behavior pass.
- The 500-project gate passes with 4/4 answer parity, no broad search, zero
  cross-project records, 97.66% fewer files inspected, and 98.63% fewer bytes
  inspected in the recorded WSL run.
- Every release tag must independently pass hosted Windows, Ubuntu, macOS,
  CodeQL, checksum, packed-lifecycle, and provenance gates before publication.

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
