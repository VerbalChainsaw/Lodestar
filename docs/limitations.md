# Lodestar limitations

## Knowledge and authority

- Lodestar stores caller-supplied meaning and evidence; it does not understand a
  repository completely or prove that a missing fact is false.
- Stored prose is data. It cannot authorize work or override the user or native
  instruction precedence.
- Source metadata records an observation. Startup and ordinary get/find/linked-peer
  reads compare local file and package manifest evidence at read time without
  changing that observation. Remote sources are not automatically refreshed, and
  a file can change after a read; inspect the affected source before depending on
  a claim marked needs_reinspection. Raw reads, history, and exports retain saved evidence.
- Required dependency failures identify incomplete context and the affected records.
  They do not prohibit unrelated work with complete required inputs.
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
- Contract-5 triggers fence INSERT, UPDATE, and DELETE row operations. They do not
  fence DDL such as DROP TABLE or isolate a file-owning SQLite client. Internal schema
  creation and migration SQL remain trusted code; external clients can read both
  records and schema. `trusted_schema=OFF` blocks trigger application functions
  outside admission, and the connection-scoped function also rejects unadmitted
  row writes when trusted schema is ON.
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

- Ordinary startup and skill verification are read-only. The explicit `setup`
  command installs native skill trees with retained backups; it does not rewrite
  AGENTS.md, host configuration, provider settings, or Golden Rules.
- A stale or divergent copy is reported with source and destination identity. A hash
  mismatch does not authorize overwrite.
- Windows owns the SQLite process boundary. WSL uses the Windows one-shot shim and must
  not open the database directly.
- Node.js 24.15.0 or newer is required for the built-in SQLite API used by this release.
- File verification covers the reported user skill roots, not arbitrary project,
  plugin, or additional configured roots, host enablement, or model invocation.
- Installation replacement is recoverable per skill tree, not an atomic switch
  across every host. Restart host sessions after an upgrade; retry interrupted
  setup to settle pending replacements. Retained backups live outside skill discovery.
- Flushed files and process-exit recovery tests do not certify physical power-loss
  durability on every filesystem. Installer locks coordinate setup processes;
  arbitrary external writers can still race the final check and rename. Changed or
  malformed recovery state is preserved for inspection, not silently overwritten.
- Host authentication and provider availability are independent of installation.
  Native discovery can succeed while an expired login prevents a model session.
- Startup reports a fresh installation plan and correction route; it cannot repair
  a missing executable before being invoked. Initial package installation and
  explicit authorized setup remain necessary. Already-loaded host sessions need
  to restart after instructions change.
- Startup checks the reported selected homes and launcher paths. Extra configured
  roots and alternate executable paths require explicit selection or native host
  inspection. A verified installation does not prove an LLM used it correctly.

## Transport and evidence

- Shell and host output limits are external. File/stdin argument transport and
  complete output files provide a supported way around them; they cannot recover
  a request already truncated by its caller. Do not act on clipped required input.
- Mutation bodies and JSON argument arrays are limited to 16 MiB of UTF-8 input
  bytes, including whitespace and a BOM. File/stdin overflow returns `resource_limit`
  before parsing or dispatch and reports the observed byte count and maximum.
  Stdin stops at the first overflowing chunk; the reported count is a lower bound
  on its complete size. Preserve the original request at its source and reduce it
  deliberately before retrying; the CLI does not truncate or reread overflow input.
- Argument-file contents are core arguments, not shell commands. Under WSL and
  Git Bash they require Windows-visible paths and explicit context/home options;
  adapters do not reinterpret embedded JSON. Structured input supports exact
  runtime JSON numbers, not arbitrary-precision numeric storage.
- Shared JSON processing has a 1,024-container nesting limit. Oversized nesting
  fails with a typed `resource_limit`; use shallower objects or linked records.
  Canonical numeric normalization treats `-0` as `0`; use a string when the sign
  itself carries meaning. Standalone parser helpers use their supplied byte budget;
  file/stdin admission and the Manager editor enforce the 16 MiB input limit.
- Stored SQLite JSON has a 1,000-container limit including its enclosing record
  and receipt wrappers; see docs/schema.md. MCP frames, metadata included, use
  the 16 MiB input limit. Its child calls share a 30-second deadline, 64 MiB combined
  stdout/stderr budget and complete two-channel envelope validation. Oversized
  frames fail explicitly and discard through newline to keep the next frame
  aligned. A dispatched mutation with an incomplete response remains unknown;
  preserve the original tool request and reconcile before exact replay.
- Manager automatic find loading stops at 10,000 records or 128 pages by default,
  including empty pages. A stopped read is explicitly partial and includes a
  revision-pinned continuation argument array. Damaged-row coverage is preserved.
  This bounds a misbehaving configured CLI; it does not silently claim completion.
- Both response channels must contain valid UTF-8. A malformed stdout or stderr
  identifies its channel and retains an unknown outcome after write dispatch.
  A valid envelope on the other channel cannot prove that the malformed channel
  contains no conflicting response. Pre-aborted operations report no dispatch.
- Windows path comparison retains the established ASCII case rule. Unicode
  folding is accepted only when filesystem resolution proves the folded name
  refers to the same path. Unavailable paths do not supply Unicode alias proof.
  Arbitrary ASCII case-sensitive Windows path identity is not claimed by this
  comparison; use project roots that differ beyond ASCII letter case.
  Drive-mount translation preserves ordinary UNC
  server/share identity. Correct genuinely ambiguous legacy mappings deliberately.
  If stored rows use a changed older Unicode fallback scope, orientation reports
  the difference with a supported literal read; it does not silently attach those
  records to another physical directory.
- A successful local transaction proves acceptance, not truth of caller-supplied
  content or completion of an external action. Preserve observed evidence, its
  applicability, and uncertainty; resolve stale or conflicting records through the
  existing guarded update path instead of silently treating old prose as authority.
- A live mutation error followed by an unclassified or unsupported process exit
  leaves the write outcome unknown. Loader preserves the original response,
  error instructions and an identity-bound uncertainty diagnostic through reopen
  and later rejection. Saved response JSON has no process exit to infer; Loader
  validates its envelope and the original request independently. A matching
  successful receipt can settle the pending request.
