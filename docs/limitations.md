# Lodestar limitations

## Knowledge and authority

- Lodestar stores caller-supplied meaning and evidence; it does not understand a
  repository completely or prove that a missing fact is false.
- Stored prose is data. It cannot authorize work or override the user or native
  instruction precedence.
- Source metadata records an observation. It cannot prove that source is still current
  after its bytes change.
- Search is deterministic substring matching, not semantic search. Links are explicit
  and one hop.

## Identity and integration

- The database is local and single-user. Scope organizes context; it is not access
  control.
- MCP does not provide authenticated Codex user/session identity to this adapter. The
  adapter therefore cannot perform identity-required claims unless an actual host
  invocation supplies those fields through an authenticated route.
- A native skill expresses automatic preference; it is not a deterministic scheduler.
  Installed files and package tests alone do not prove an agent invoked Lodestar.
- Missing optional Lodestar context does not block native project work with complete
  required inputs.

## Storage and transactions

- SQLite protects normal atomic commits but cannot recover malicious replacement,
  faulty storage, or unavailable post-backup writes.
- The file is not encrypted, signed, or authenticated. Protect it with operating-system
  permissions and tested backups.
- Request receipts make database effects idempotent. They do not make an external
  action and its later ledger update one atomic transaction.
- `doctor` diagnoses; it does not repair. Raw source correction is deliberate because
  unsafe numeric JSON cannot be normalized without loss.

## Compatibility and recovery

- Current runtime reads and writes schema 5 only. It has one explicit, preserving
  schema-4 conversion and no general historical converter suite.
- Converting another actual store requires an exact inspected preservation mapping.
- After accepted schema-5 writes, restoring a pre-conversion store as active would
  discard accepted history and is unsupported. Forward recovery must account for all
  known records, events, receipts, raw history, and associations before promotion.
- There is no schema-5 downgrade converter.

## Distribution

- Lodestar verifies skill trees read-only. It does not install, merge, replace, or
  remove native skill or AGENTS.md files.
- A stale or divergent copy is reported with source and destination identity. A hash
  mismatch does not authorize overwrite.
- Windows owns the SQLite process boundary. WSL uses the Windows one-shot shim and must
  not open the database directly.
- Node.js 24.15.0 or newer is required for the built-in SQLite API used by this release.
