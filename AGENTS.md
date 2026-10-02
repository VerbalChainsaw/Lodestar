# Lodestar repository instructions

## Unified Lodestar boundary

Lodestar is the single machine-state suite. Project orientation, knowledge, work
presence, and handoff use one executable, one universal record model, and one
SQLite database.

The one-shot Lodestar core owns:

- atomic, idempotent typed-record operations;
- typed reads, project context, knowledge, `work`, and `handoff` command families;
- one contract-5 JSON success/error envelope; and
- migration and doctor support required by that persisted state.

The Director has also authorized the Windows Loader and terminal Manager. They
expose the same authority through typed operations, including Attention,
capture/linking, reviewed saves and exact-request recovery. They do not create a
second store or independent task authority.

The explicit `setup` command and Windows distribution tools own selected skill
and launcher deployment, installation, update, uninstall registration and
recovery. They require ownership checks, external database selection, preserved
configuration and retained interruption evidence. They do not run during ordinary
startup. Never copy or retire a database as part of an application replacement.

Optional native host integration owns explicitly activated compaction checkpoint
and bounded context restoration hooks. It calls the one-shot core; the native
host owns hook delivery and execution. Preserve installed host customizations.

Unless the Director explicitly reauthorizes them, Lodestar must not own or implement:

- a persistent HTTP/loopback daemon, service discovery, health endpoint, idle service lifecycle, or any background server;
- hooks embedded in the one-shot core, or Codex App Server calls;
- creating, injecting, or continuing Codex threads;
- automatic session rotation or successor creation; or
- direct WSL access to the SQLite file.

The cross-OS boundary is one one-shot, Windows-owned Lodestar operation per
request. WSL invokes the installed shim and Windows Node. Normal Codex handoff
operation must not ask the user to use a terminal.

Do not revive retired compatibility products or command suites. Keep the
model-facing surface entirely under Lodestar.

Do not change quality thresholds merely because the implementation grew. Any gate change requires explicit Director approval and an actual changed product contract.

Keep recovery in the existing record, receipt, interface journal and deployment
owners. If another independent subsystem is proposed, preserve WIP and obtain a
concrete scope decision before expanding Lodestar.

The accepted runtime has no service/client/discovery/serve/bootstrap-server
surface. Preserve the one-shot boundary unless concrete evidence invalidates it.

## Repository verification invariants

Managed skill payloads are byte-verified: the exact bytes under
`managed-assets/skills/**` are recorded in `managed-assets/manifest.json`, and
`npm test` (CI) fails on a stale manifest. After editing any managed skill
file, regenerate with
`npm run assets:build -- --source-root "<Golden-Rules-root>"` (write mode
requires the explicit Golden source root; `--check` runs without one), review
the generated diffs (manifest, Codex plugin mirror, bootstrap stub,
`docs/agent-bootstrap.json`), then run `npm test`. Four Golden-owned skills
mirror the Golden Rules source; `lodestar` and `adderall` skill payloads are
repository-owned. Bootstrap parity (bootstrap.json ↔ stub ↔ documented copy)
is verified separately from the skill payload manifest.
