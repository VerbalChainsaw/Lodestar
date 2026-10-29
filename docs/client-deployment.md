# Deploy a reviewed Lodestar candidate to existing clients

The core is one-shot. Do not add a service or create a new database during rollout.

1. Pin the reviewed commit/tree and package SHA-256. Inventory every package path and byte hash. Build from the exact tracked archive, never from an existing installation or a mixed working tree.
2. Read current ownership and reconcile installed differences. Preserve the full prior installed tree, entrypoint/config bytes and hashes outside host skill discovery. A backup protects bytes but does not authorize removing another owner's active behavior.
3. Install into a new versioned user-local prefix with the supported package manager. Verify the complete payload manifest and zero unexpected payload files. Keep existing client routes unchanged until the switch is agreed. An isolated verification is not global activation.
4. Switch only the discovered existing routes through their supported configuration/launcher mechanism, with a complete before/after allowlist and rollback. Do not rotate credentials, change trust, broaden access, restart healthy services or edit shared client source as a side effect.
5. For each client, record configured route, actual loaded core/plugin version, exact artifact identity, a real bounded read, and remaining gaps. Do not claim another identity's execution from a proxy shell.
6. Restore the saved route/config if acceptance fails. Preserve uncertain writes and request IDs; never replay a mutation or external action to test rollback. Do not remove the previous package until rollback is no longer needed and retirement is authorized.

## Client-specific boundaries

| Existing client | Configuration/readiness evidence | Actual proof required |
|---|---|---|
| Codex native adapter | Existing plugin ID, cached adapter version, enabled state and supported core discovery | Native read-only status with real host attestation, plus bounded core read; no invented session metadata |
| Codex generic MCP | Existing complete-package marketplace/cache and MCP declaration | Existing server's version/describe/read; do not replace a native adapter that provides required hooks |
| Claude / OpenCode | Existing skill roots, configured MCP or CLI route and host-specific rules | Actual existing tool/CLI consumer; file verification alone is insufficient |
| Rook / Hermes | Actual profile/home, retained owner's launcher and native tool route | Owner's bounded read through that route; do not infer from another profile |
| Miles / DeepSeek / Maxwell via AgentLink | Existing named client connection and shared controller configuration | A call from that actual client/session; controller health or another user's read is only shared-path evidence |

Use `setup` without `--apply` before skill deployment. It may include several independently owned skills; never use blanket `--replace-local` merely to make verification green. Preserve custom instructions and record selective merges truthfully. A core upgrade does not refresh a separately cached Codex plugin; use the existing plugin manager without deleting its state or silently changing hook trust.

`Missing host attestation` is an integration boundary, not a missing database or reason to synthesize identity. Keep ordinary CLI reads separate while the host supplies its supported session metadata. A plugin restart or new trust grant requires the corresponding host authorization; it is not implicit in a successful file copy.

Current/complete health, cold-history uncertainty, and cache generation trust remain separate. Do not run full historical diagnostics repeatedly for rollout, substitute quick checks for full health, restore archives automatically, or claim that local file metadata prevents same-user tampering.
