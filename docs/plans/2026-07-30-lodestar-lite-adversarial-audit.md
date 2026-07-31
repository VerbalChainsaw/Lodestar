# LodestarLite adversarial hardening audit

Date: 2026-07-30

CENTER follow-up: 2026-07-31

Branch: `LodestarLite`

Baseline reviewed: the architectural reduction from v0.7.0 at
`27d61c3c71ed1896b6ef0828e446bf959f96221f`

## Audit-tool availability

The initial direct review produced A-01 through A-18. The requested
`center-audit` capability was then obtained from
`VerbalChainsaw/center-audit`, installed locally, and used for a bounded
follow-up on transaction-error truthfulness; that pass confirmed A-19.
Persistence, machine-interface, package, and legacy-migration lenses then
challenged the committed repairs four times. Those passes confirmed H-01
through H-21 and required independent terminal reproductions before edits.

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

### Multi-angle findings

The follow-up codeplan records the complete repair contracts and red/green
sequence. The closing dispositions are:

| ID | Severity | Confirmed defect | Closing disposition |
| --- | --- | --- | --- |
| H-01 | high | Schema enumeration confused `_` in `LIKE` with a literal underscore. | Match the literal SQLite namespace and use an independent test oracle. |
| H-02 | medium | Arbitrary thrown values could forge or overflow the public error contract. | Trust only constructed Lodestar errors and normalize one bounded snapshot. |
| H-03 | medium | Search filters accepted values impossible for stored type and scope fields. | Apply the corresponding stored-field validator. |
| H-04 | medium | String stream chunks could silently replace unpaired UTF-16 surrogates. | Validate surrogate continuity across chunks before UTF-8 encoding. |
| H-05 | medium | A generated migration ID could consume a later valid original ID. | Reserve all valid original identifiers before allocation. |
| H-06 | medium | The importer ignored the v0.7 pointer version. | Require the documented `current.json.v === 1` contract. |
| H-07 | medium | Orphan locator-health evidence disappeared from migration reports. | Report every unowned observation as bounded unsupported evidence. |
| H-08 | low | The package shipped a README link whose target was omitted. | Remove the artifact-relative dependency and validate all packaged relative Markdown links. |
| H-09 | high | A corrupt reserved-prefix trigger could be mistaken for SQLite-maintained state. | Allow only exact inert statistics-table definitions; reject every other reserved object. |
| H-10 | medium | Empty chunks bypassed stream-count bounds and oversized chunks were copied first. | Count every chunk and reject prospective byte excess before copying. |
| H-11 | medium | Non-byte typed input was silently coerced into JSON bytes. | Accept only string, Buffer, and byte-exact Uint8Array chunks. |
| H-12 | medium | A mutable error code could disagree between JSON and process exit status. | Derive both signals from the same immutable bounded snapshot. |
| H-13 | high | Duplicate or non-string legacy IDs could duplicate or misreport locator health. | Resolve normalized ownership once and give each observation one disposition. |
| H-14 | high | Failed reservation cleanup could unlink a database completed by another process. | Never unlink a published reservation; safely resume zero-byte targets and recognize a completed winner. |
| H-15 | medium | Import called a definite pre-commit failure an unknown commit outcome. | Use SQLite transaction state to distinguish rollback-confirmed failure from ambiguity. |
| H-16 | medium | Doctor could approve stored values that public reads rejected. | Apply the complete bounded public semantic contract to every stored table. |
| H-17 | medium | Find and links summaries omitted validation of `created_at`. | Select and validate both record timestamps. |
| H-18 | medium | Unique locator-health evidence was consumed before its source survived conversion. | Consume it only after an accepted source retains it; otherwise report it once. |
| H-19 | medium | A revoked proxy in a genuine error could make normalization throw without JSON or an exit result. | Make diagnostic reflection total and retain a fixed `runCli` internal-error fallback. |
| H-20 | medium | A `Uint8Array` subclass could underreport its length before a large copy. | Read identity and byte length through cached typed-array intrinsics before copying. |
| H-21 | medium | A prototype-spoofed byte object could be truncated into valid JSON and persisted. | Require genuine `Uint8Array` internal slots and reject the spoof before conversion. |

The detailed implementation plan is
[the multi-angle hardening codeplan](2026-07-31-lodestar-lite-multi-angle-hardening-codeplan.md).

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

## Closing multi-angle result

The final repaired-head challenge followed only proven edges around three
high-consequence boundaries:

```text
database reservation -> SQLite transaction state -> failure cleanup
stored row -> doctor validator -> public read validator
legacy health key -> candidate source -> accepted row or migration report
programmatic chunk/error -> intrinsic or total normalization -> JSON result
```

A forced concurrent interleaving proved the old cleanup race before H-14 was
repaired: one process reserved the path, another completed the visible
zero-byte reservation, and the first process then unlinked the healthy winner.
The repaired path preserves published reservations and recognizes a valid
concurrent result. Pre-commit and post-commit injections now distinguish
rollback-confirmed failure from a genuinely unknown outcome.

Direct schema-valid row changes proved H-16 and H-17 before repair. The closing
doctor matrix now applies the same bounded Unicode, byte, JSON-depth,
knowledge-state, and timestamp rules as `get`, `find`, `links`, and `export`.

The migration lens independently exercised accepted, duplicate-owner,
non-string-owner, rejected-record, invalid-locator, duplicate-origin,
source-limit, and metadata-compaction cases. In every case each
locator-health observation was either persisted once or reported once. A
2,505-observation stress case retained deterministic order and reported exact
2,000 emitted and 505 omitted details.

The installed-interface lens then confirmed H-19 through H-21. The repaired
boundary does not trust `instanceof`, an overrideable typed-array property, or
successful reflection on caller-controlled diagnostics. Genuine Buffer and
`Uint8Array` chunks remain accepted; spoofed or unreadable objects fail with a
bounded JSON result before persistence.

No defect was confirmed after those repairs. Confidence is high within the
reviewed same-user, accepted-input, local-filesystem boundary; this remains a
bounded audit rather than a formal proof.

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
- The importer fingerprints the documented accepted source-file set. Added
  unrelated files, same-content same-user path replacement, and an unsealed
  generation whose recorded hash disagrees with its directory name are policy
  boundaries rather than silently invented corruption claims.
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

- exact Node.js `v24.15.0`: 80 tests passed, 0 failed;
- built-in coverage: 78.83% lines, 79.08% branches, and 96.06%
  functions;
- every runtime and test module passed `node --check`;
- YAML parsing succeeded for all retained workflows and Dependabot config;
- `git diff --check` passed;
- dependency tree is empty;
- runtime has no network, background-worker, provider, installer, benchmark, or
  orchestration imports;
- final package: 30 entries, 46,785 packed bytes, 193,175 unpacked bytes;
- two independent final packs were byte-identical at SHA-256
  `ca209dd8a4a9ebddc04f46140a9dd65c4ee12d980aacd649c876930609dc5103`;
- final package declares exactly one executable, `lodestar`;
- an installed tarball exercised all nine public commands;
- all nine command help contracts plus top-level help returned JSON without
  creating the requested database;
- database hashing was unchanged across packaged `get`, `find`, `links`,
  `doctor`, and `export`;
- installed programmatic probes rejected revoked diagnostics, underreported
  typed-array subclasses, and prototype spoofs before persistence while
  accepting genuine Buffer and `Uint8Array` chunks;
- an actual sealed v0.7.0 checkout store passed dry-run and committed import,
  doctor was healthy, alias retrieval succeeded, and before/after source
  content and tree hashes matched;
- the largest runtime module is below 500 physical lines;
- the operational core, including the executable and excluding the isolated
  one-way importer, is 3,924 lines;
- total shipped JavaScript is 6,088 lines, 8,881 fewer than v0.7.0 (59.3%).

## Conclusion

The 40 confirmed findings are closed, with no known high- or medium-severity
defect remaining in the reviewed scope. The reduced runtime meets the stated
local-registry boundary. The mechanisms
that remain complex directly protect transaction truth, bounded machine
interfaces, stored-data integrity, or one-way migration. The audit found no
justification to restore generations, custom locks, snapshots, provider
behavior, installers, benchmarks, orchestration, or another executable.
