# Bootstrap and failure rules

Codex, Claude, Hermes, and OpenCode use the same redirect: obtain and validate
one complete `lodestar start --cwd <cwd>` response at session startup. Host
adapters may recognize exact commands, redact, attest, and invoke a bounded
one-shot CLI process. They do not own durable state or implement Lodestar
semantics.

When a reliable session identity exists, invocation failure, missing output,
clipping, malformed output, or validation failure is recovered by retrying the
same canonical project and session identity. Lodestar returns the identical
persisted startup snapshot. Apply exactly one validated snapshot; never combine
retry responses or apply more than one snapshot. Without a reliable session
identity, startup remains stateless and does not promise replay persistence.

Startup returns one versioned JSON envelope in this order: canonical project;
required global and project governance; current decision facts and dead values;
smallest relevant knowledge; advisory active work; and an eligible continuity
recovery. Optional knowledge is shed before required data. Required governance or
decision negations must never be silently clipped.

Stop without mutation only when complete startup recovery is unavailable or
same-session retry responses conflict. Report the exact context failure and do
not invent omitted authority. A failed startup transaction must leave both the
startup snapshot unpersisted and a pending recovery unclaimed.

Lodestar uses one Windows-owned SQLite database and one migration/backup policy.
It has no runtime network dependency, daemon, discovery service, or background
indexer. WSL clients cross the proven Windows one-shot boundary and never open
SQLite directly.
