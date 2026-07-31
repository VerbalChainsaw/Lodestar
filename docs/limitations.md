# Lodestar limitations

Lodestar is deliberately a local structured registry, not a project
understanding platform.

## Knowledge boundary

- Lodestar knows only records supplied or imported by a caller.
- It does not recursively inspect repositories or automatically discover facts.
- Missing knowledge is not proof that an underlying value does not exist.
- `known_empty` is a direct assertion about an inspected source, not a
  completeness claim.
- Freshness and inspection fields are assertions Lodestar stores; it does not
  independently verify them.
- Search is bounded substring matching over stored fields. It is not semantic
  search and does not use the filesystem.
- Search case folding uses SQLite's built-in `lower()` behavior, which is
  ASCII-oriented in the bundled build. Exact IDs and aliases remain
  case-sensitive.
- Links are explicit and one-hop. Callers decide whether and how to traverse
  further.

## Storage boundary

- One SQLite file is the source of truth.
- Lodestar has no built-in history, audit chain, snapshots, restore, rollback,
  quarantine, or automatic repair.
- SQLite rolls back interrupted transactions, but it cannot recover a lost or
  maliciously rewritten database.
- `doctor` diagnoses; it does not mutate or repair.
- Use ordinary, tested backup tooling or version-controlled exports.
- The database is not encrypted, signed, or authenticated by Lodestar.
- A process that deliberately bypasses SQLite checks or rewrites pages can
  create invalid state. Reads fail closed on invalid stored envelopes and
  `doctor` reports bounded structural and semantic findings, but neither proves
  the truth or provenance of externally edited values.

## Security boundary

- Lodestar is intended for a single user's local context, not hostile
  multi-tenant access.
- Scope is organizational metadata and a search filter, not authorization.
- Anyone who can read or rewrite the database can read or rewrite its context.
- The CLI has no network requirement, daemon, telemetry, access-control server,
  or secret-management system.
- Source metadata and record content can contain sensitive information. Protect
  the database with appropriate operating-system permissions.

## Operational boundary

- There is one public executable and no plugin or provider framework.
- Lodestar does not install, configure, or orchestrate agents.
- There is no background indexing or maintenance process.
- Writers and overlapping first-use validation wait for the same bounded busy
  timeout and then report contention; Lodestar does not identify or reclaim
  another process's lock.
- Rollback-journal mode favors a simple write-light CLI. It is not tuned as a
  high-throughput database service.
- Read-only commands never initialize a missing database. The first
  structurally valid `lodestar put` initializes it automatically; `init`
  remains optional.
- A definite failure while creating a new database can leave its published
  zero-byte reservation in place. A later `put`, `init`, or import can resume
  that reservation; Lodestar does not unlink it because another process may
  have completed the same visible path.

## Compatibility boundary

- Schema version 1 is accepted exactly; unknown versions fail closed.
- There is no speculative automatic schema migration framework.
- The v0.7 importer is one-way and accepts only its documented
  generation-store layout.
- Import does not merge, overwrite populated databases, dual-write, or mutate
  the legacy source.
- Import rejects an existing destination with more than one hard link. This
  avoids path-based confinement being bypassed by a destination that aliases a
  legacy source file.
- Migration detail arrays are bounded. The report includes total, emitted, and
  omitted entry counts; users must treat `reporting.truncated: true` as
  unresolved migration evidence.
- If SQLite cannot confirm an import commit, Lodestar preserves the destination
  and reports an unknown commit outcome for read-only diagnosis instead of
  deleting possibly committed data.
- An import `COMMIT` exception is definite when SQLite still reports an active
  transaction and rollback succeeds; only an ended transaction with an
  unconfirmed commit call is reported as unknown.
- Other writes likewise report `database_commit_outcome_unknown` when SQLite
  has ended the transaction without confirming the commit call. Initialization
  preserves the database in this state; inspect it read-only before retrying.
- Node.js 24.15.0 or newer is required for the built-in SQLite interface used
  by this release.

These boundaries are product decisions. A new subsystem belongs in Lodestar
only when a demonstrated registry or migration need cannot be handled by a
normal function, SQL query, SQLite, or the operating system.
