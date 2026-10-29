# Advisory work and outcomes

Work records describe observed activity and outcomes. They do not assign ownership,
lock files, authorize edits, or prove an area is free.

- Read current and historical reports with `lodestar work status|history`.
- Record activity with `lodestar work start --file <request.json>`.
- Record a checkpoint or outcome with `lodestar work report|done --file <request.json>`.
- Correct obsolete open reports with `lodestar work expire --file <request.json>`.

All writes use the shared contract-5 request and returned basis. Work identity comes
from actual host context. A native tool or shell that lacks actor/session identity
must not guess it; current work mutations return `identity_required` when it is absent.

Record what actually happened: attempted, interrupted, failed, completed, verified, or
unknown. A historical passing test remains historical after code changes. Keep external
action success distinct from ledger persistence failure, and retry only the unchanged
logical ledger request after a lost response.

## Native Codex hook adapter

Only when this separate adapter is installed and its tools are available, call
`lodestar_work_start` with report text, `lodestar_work_done` with optional report
and outcome, or `lodestar_work_status`. A verified outcome requires evidence;
completed is the default. These record execution outcomes, not Director acceptance
or project closure. The host supplies exact identity. The adapter derives a
separate work ID from the canonical project, checkout and host session and checks
record ownership before writing. Public tool inputs cannot override actor or
session. The generic MCP plugin does not provide these host-bound tools.
