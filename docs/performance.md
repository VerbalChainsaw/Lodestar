# Lodestar Performance Testing

The full performance suite extends the paired material-lift benchmark across
multiple repository sizes and measures individual retrieval operations:

```bash
npm run benchmark:performance
```

An installed package also exposes `lodestar-performance`.

Use the quick profile while developing:

```bash
npm run benchmark:performance -- --quick
```

Machine-readable results are available with `--json`.

## Scale profiles

The default suite runs three controlled fixtures:

| Profile | Projects | Repository documents | Target document size |
| --- | ---: | ---: | ---: |
| Small | 10 | 16 | 4 KiB |
| Standard | 100 | 64 | 16 KiB |
| Stress | 500 | 256 | 32 KiB |

Every profile runs the same questions through broad repository discovery and
Lodestar's real `start` plus `resolve` path. It records correctness, files and
bytes inspected, evidence bytes, median elapsed time, scope leakage, and
determinism.

## Operation probes

The standard 100-project fixture also records distributions for:

- fresh-store `start`, opening a new `ContextStore` for every sample;
- warm-store `start`;
- cached exact `get`;
- cached linked `resolve`;
- scoped indexed `find`; and
- batches of 16 parallel cached exact reads.

Each result includes sample count, minimum, p50, p95, maximum, and arithmetic
mean. Memory reporting contains before-and-after RSS and heap snapshots.

## Interpretation limits

“Fresh store” does not mean cold disk. The Node.js object is recreated, but the
process and operating-system filesystem caches remain intact. Portably flushing
those caches would require elevated, platform-specific operations and would make
the tool unsafe and difficult to reproduce.

Timing and memory are observations, not release gates. They vary with:

- processor and storage hardware;
- Windows Defender or other antivirus scanning;
- WSL filesystem placement;
- operating-system cache state;
- background load;
- Node.js garbage collection; and
- power-management policy.

Use the deterministic correctness, scope, and inspected-byte gates to catch
functional regressions. Use p50 and p95 trends from the same machine and fixture
parameters to investigate performance regressions.

For publishable comparisons:

1. record the commit and JSON report;
2. use the same Node.js major version;
3. run on an otherwise idle machine;
4. compare identical profile parameters;
5. report Windows and WSL separately; and
6. retain unfavorable measurements rather than selecting only winning runs.
