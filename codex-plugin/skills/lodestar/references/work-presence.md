# Advisory work presence

Work reports describe what peers say they are doing. They are never assignments,
ownership, locks, permission to edit, or proof that an area is free.

- Inspect active reports: `lodestar work status`.
- Start or update this actor's report: `lodestar work start "<current work>"`.
- Close it idempotently: `lodestar work done "<completion>"`.

Identity comes from the host, not the shell. In a host running the Lodestar plugin
(Codex Desktop), call the bundled tools — `lodestar_work_start`, `lodestar_work_done`,
`lodestar_work_status` — which carry the exact session id the host already knows.
A plain shell has no session id, so `lodestar work start` there requires an explicit
`--session <id>`. Lodestar refuses rather than guessing: work records are keyed by
actor, so a guessed session would capture and then overwrite a concurrent peer's
marker.

- Review bounded deterministic history: `lodestar work history`.
- Explicitly expire old open reports: `lodestar work expire --older-than-hours <n>`.

Lodestar derives project/worktree identity canonically and actor identity from the
exact session, agent, and host harness. Each actor has at most one open report;
repeated start updates it instead of creating a duplicate. Repeated done is a
safe no-op. Status and history use deterministic ordering.

`STALE?` means only that a report is old. It is not evidence of abandonment and
must not be used to take over files or discard work. Expiration is explicit,
bounded, auditable, and changes only qualifying advisory reports. Use
`lodestar doctor` for stored-state checks; do not edit work rows directly.
