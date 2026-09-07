# Lodestar repository instructions

## Unified Lodestar boundary

Lodestar is the single machine-state suite. Project orientation, knowledge, work
presence, and handoff use one executable, one universal record model, and one
SQLite database.

Lodestar may own only:

- atomic, idempotent typed-record operations;
- the `start`, knowledge, `work`, and `handoff` command families;
- one contract-5 JSON success/error envelope; and
- migration and doctor support required by that persisted state.

The explicit `setup` deployment command may install the packaged native skill
payloads and selected launchers with ownership checks, retained backups, and
interruption recovery. It does not run during startup or write host governance.

Unless the Director explicitly reauthorizes them, Lodestar must not own or implement:

- a persistent HTTP/loopback daemon, service discovery, health endpoint, idle service lifecycle, or any background server;
- Codex hooks or Codex App Server calls;
- creating, injecting, or continuing Codex threads;
- automatic session rotation or successor creation; or
- direct WSL access to the SQLite file.

The cross-OS boundary is one one-shot, Windows-owned Lodestar operation per
request. WSL invokes the installed shim and Windows Node. Normal Codex handoff
operation must not ask the user to use a terminal.

Do not revive retired compatibility products or command suites. Keep the
model-facing surface entirely under Lodestar.

Do not change quality thresholds merely because the implementation grew. Any gate change requires explicit Director approval and an actual changed product contract.

If recovery requires another independent subsystem, preserve WIP and split the work instead of expanding Lodestar.

The accepted runtime has no service/client/discovery/serve/bootstrap-server
surface. Preserve the one-shot boundary unless concrete evidence invalidates it.
