# LodestarLite adversarial hardening audit

Date: 2026-07-30

CENTER follow-up: 2026-07-31

Branch: `LodestarLite`

Baseline reviewed: the architectural reduction from v0.7.0 at
`27d61c3c71ed1896b6ef0828e446bf959f96221f`

## Audit-tool availability

The requested `center-audit` capability was not present when the initial
adversarial review began, so findings A-01 through A-18 came from a direct
review. At the user's direction, `center-audit` was then obtained from
`VerbalChainsaw/center-audit`, installed locally, and used for a bounded
follow-up on transaction-error truthfulness. That CENTER v2.5.1 pass confirmed
one additional defect, A-19, and independently reproduced it before repair.

## Scope and invariants

The review covered:

- CLI parsing, help, JSON output, error output, and exit codes;
- SQLite creation, open modes, schema checks, transactions, and interruption;
- record, alias, link, source, search, export, and delete semantics;
- doctor behavior against malformed and directly modified databases;
- v0.7 source confinement, integrity evidence, conversion, reporting, and
  destination handling;
- published package contents, executable count, dependencies, and workflows;
- boundedness under large, malformed, sparse, deeply nested, or changing input.

The principal invariants were:

1. A read command must not create or mutate state.
2. A failed pre-commit write must leave no partial application data.
3. An ambiguous commit must preserve evidence and state that it is ambiguous.
4. Import must never write through a path that aliases the legacy source.
5. Every externally controlled input and emitted diagnostic must be bounded.
6. Malformed stored data must fail closed, not be silently normalized.
7. Missing or absent evidence must not become a completeness claim.
8. Only the reduced runtime and one executable may ship.

## Closed findings

No known high- or medium-severity finding remains open in the reviewed scope.

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| A-01 | medium | A new record could claim an alias identical to its own ID because collision checking preceded insertion. | Reject aliases equal to the input ID and retain the global record-ID collision check. |
| A-02 | high | One huge unknown CLI argument could be reflected into a multi-megabyte error response. | Bound each argument, aggregate arguments, diagnostic identifiers, and encoded command output. |
| A-03 | high | A file could grow between `stat` and `readFile`, bypassing the declared byte limit. | Read through bounded handles in chunks and abort as soon as the limit is crossed. |
| A-04 | high | Deep, structurally huge, or sparse JSON could consume excessive stack, CPU, or memory during canonicalization. | Bound depth and structural nodes and reject sparse arrays. |
| A-05 | medium | Unpaired UTF-16 surrogates could be replaced by SQLite, changing identifiers or schema text silently. | Reject unpaired surrogates at JSON, identifier, CLI, and path boundaries; sanitize only explicitly mapped legacy display values. |
| A-06 | low | Numeric limit options accepted JavaScript forms such as exponent or hexadecimal notation. | Accept positive decimal digit strings only. |
| A-07 | medium | Initial SQL constraints measured characters rather than UTF-8 bytes and allowed weak timestamp shapes. | Enforce byte bounds and exact millisecond UTC timestamps in both validation and schema checks. |
| A-08 | high | Check-then-create database initialization could overwrite or clean up a concurrent creator. | Reserve with `wx`, use restrictive creation permissions, and clean up only the exact file reserved by the current operation. |
| A-09 | medium | A crash after reservation could leave a zero-byte file that could never be resumed. | Permit initialization and import to resume an existing zero-byte regular destination without treating arbitrary files as empty databases. |
| A-10 | high | A post-commit error could be treated as an ordinary failure; initialization could then delete a database whose commit had landed. | Report `database_commit_outcome_unknown`, skip destructive cleanup, and preserve the database for read-only diagnosis. |
| A-11 | high | Import conversion performed repeated record counts and migration detail arrays could grow without a useful report bound. | Validate the total once, insert records before links, cap detail entries and entry bytes, and report exact omitted counts. |
| A-12 | medium | Migrated source counts and legacy locator observations could be lost or overstated. | Count actual source rows, map locator paths and exact health observations, and retain `inspection: "unknown"` when evidence is absent. |
| A-13 | high | Project shard names containing astral Unicode differed because the importer used code-point iteration while v0.7 used UTF-16 code units. | Match the v0.7 shard algorithm exactly and cover it with an emoji-ID regression. |
| A-14 | high | Optional nested paths, sealed-generation enumeration, and JSONL splitting had unbounded or incorrect edge cases. | Make optional traversal genuinely optional, enumerate with bounded `opendir`, and scan JSONL without whole-file line-array amplification. |
| A-15 | high | Doctor could continue through a corrupt schema, serialize invalid metadata poorly, or collect too many malformed rows. | Stop after failed integrity, bound every issue query, validate required metadata directly, and check ownership and envelope limits. |
| A-16 | high | Reads and export could trust malformed JSON inserted outside Lodestar or allocate the entire export before checking its size. | Validate stored rows on retrieval and iteration; build export incrementally with a pre-allocation byte guard. |
| A-17 | medium | Required object properties could be inherited through a crafted prototype. | Require own properties while preserving safe JSON keys such as `__proto__` as data. |
| A-18 | high | An import destination outside the source path could be a hard link to a source file, bypassing path confinement and mutating the old store. | Reject existing import destinations with more than one hard link and retain symlink and physical-path checks. |
| A-19 | medium | Initialization transaction failures omitted the explicitly selected database path from the stable JSON error envelope. | Forward the destination through initialization's transaction boundary and test exact identifiers for both definite pre-commit failure and ambiguous post-commit failure. |

Each resolution has a regression or is exercised by the integration gates
below. The tests deliberately include direct database bypass, injected
post-commit failure, concurrent creators, changing files, Unicode shard names,
symlink and hard-link aliases, and oversized migration reports.

## CENTER follow-up result

The bounded center-out trajectory was:

```text
lodestar init --db <path>
  -> initializeDatabase(file)
  -> initializeConnection(db, { createdAt })
  -> transaction(db, operation, database = null)
  -> normalized SQLite error
  -> public JSON error envelope
```

The explicit path was present at the command boundary but dropped at the
`initializeConnection` call. An independent disposable-database reproduction
therefore observed `identifiers.database: null` after an injected post-commit
error. Confidence was high: the value loss was direct, deterministic, and
limited to initialization transaction failures. Successful initialization and
transaction call sites that already supplied a database identifier were
outside the blast radius.

Two broader suspicions were disproved:

- injected failure before `COMMIT` rolled back with zero application rows and
  a definite `database_error`;
- injected failure after the real `COMMIT` preserved the row and returned
  `database_commit_outcome_unknown`.

The smallest safe repair was to pass `file` through
`initializeConnection(..., { database: file })`; no transaction classifier or
cleanup behavior changed. The repair revalidation result was
`INVARIANT_HOLDS` at both the database and public CLI boundaries.

## Residual risks and non-guarantees

These are explicit product boundaries, not hidden completeness claims:

- Lodestar is a same-user local registry, not an authorization or hostile
  multi-process boundary. A malicious process that can replace the database,
  its parent directories, or source files during a command remains able to
  interfere with it.
- The database is not encrypted, signed, replicated, or backed up by Lodestar.
  SQLite durability cannot protect against lost storage, malicious
  replacement, or an untrustworthy operating system.
- The v0.7 store format proves a compatible layout and available integrity
  evidence, not the exact npm package version that created every generation.
- Migration reports are bounded. A report with omitted entries remains
  unresolved evidence and must be reviewed before discarding the old store.
- Search uses deterministic SQLite/JavaScript behavior with documented ASCII
  case folding. It is not a locale-aware or semantic search engine, and a
  maximum-size registry may require a full bounded scan.
- Rollback-journal mode and a five-second busy timeout suit a write-light local
  CLI, not a high-throughput service.
- The local gate ran on the current Linux/WSL environment. The GitHub workflow
  is configured for Linux, macOS, and Windows, but hosted matrix results cannot
  exist until the branch is pushed.
- This was a targeted adversarial review, not a coverage-guided fuzzing campaign
  or a formal proof of SQLite, Node.js, or filesystem behavior.

## Verification evidence

Final local gates:

- exact Node.js `v24.15.0`: 51 tests passed, 0 failed;
- every runtime and test module passed `node --check`;
- YAML parsing succeeded for all retained workflows and Dependabot config;
- `git diff --check` passed;
- dependency tree is empty;
- runtime has no network, background-worker, provider, installer, benchmark, or
  orchestration imports;
- final package: 28 entries, 43,066 packed bytes, 177,980 unpacked bytes;
- final package declares exactly one executable, `lodestar`;
- an installed tarball exercised all nine public commands;
- all nine command help contracts plus top-level help returned JSON without
  creating the requested database;
- database hashing was unchanged across packaged `get`, `find`, `links`,
  `doctor`, and `export`;
- an actual sealed v0.7.0 checkout store passed dry-run and committed import,
  doctor was healthy, alias retrieval succeeded, and before/after source
  content and tree hashes matched;
- the largest runtime module is below 500 physical lines;
- the operational core, including the executable and excluding the isolated
  one-way importer, is 3,550 lines.

## Conclusion

The reduced runtime meets the stated local-registry boundary. The mechanisms
that remain complex directly protect transaction truth, bounded machine
interfaces, stored-data integrity, or one-way migration. The audit found no
justification to restore generations, custom locks, snapshots, provider
behavior, installers, benchmarks, orchestration, or another executable.
