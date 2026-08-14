# Bootstrap and failure rules

Codex, Claude, Hermes, and OpenCode use the same redirect: run
`lodestar start --cwd <cwd>` once at session startup. Host adapters may recognize
exact commands, redact, attest, and invoke a bounded one-shot CLI process. They do
not own durable state or implement Lodestar semantics.

Startup returns one versioned JSON envelope in this order: canonical project;
required global and project governance; current decision facts and dead values;
smallest relevant knowledge; advisory active work; and an eligible continuity
recovery. Optional knowledge is shed before required data. Required governance or
decision negations must never be silently clipped.

If startup, governing instructions, a continuity packet, or the user's task is
truncated, malformed, or incomplete, stop without mutation and report the exact
context failure. Do not invent omitted authority. A failed startup transaction
must leave a pending recovery unclaimed.

Lodestar uses one Windows-owned SQLite database and one migration/backup policy.
It has no runtime network dependency, daemon, discovery service, or background
indexer. WSL clients cross the proven Windows one-shot boundary and never open
SQLite directly.
