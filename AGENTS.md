# Lodestar governance

## Durable Handoff boundary

Lodestar is Handoff's durable transaction/store layer. It is not the Handoff product UI or runtime.

Lodestar may own only:

- schema-owned durable continuity state: lane, packet, tail/event, and transfer/claim;
- atomic, idempotent continuity operations;
- JSON CLI/API output sufficient for an internal caller; and
- migration and doctor support required by that persisted state.

Unless the Director explicitly reauthorizes them, Lodestar must not own or implement:

- a persistent HTTP/loopback daemon, service discovery, health endpoint, idle service lifecycle, or any background server;
- Codex hooks or Codex App Server calls;
- creating, injecting, or continuing Codex threads;
- user-facing `handoff` commands or automatic session rotation; or
- direct WSL access to the SQLite file.

The cross-OS boundary is one one-shot, Windows-owned Lodestar operation per request. A WSL Codex plugin may internally invoke the installed Lodestar shim and Windows Node. Normal Handoff operation must never ask the user to use a terminal.

The current Tranche-1 continuity commit is salvageable prototype material. Future work must simplify around the core continuity operations, not extend the service layer.

Do not change quality thresholds merely because the implementation grew. Any gate change requires explicit Director approval and an actual changed product contract.

If recovery requires another independent subsystem, preserve WIP and split the work instead of expanding Lodestar.

## Current recovery directive

The next Lodestar change should remove or retire the service/client/discovery/serve/bootstrap-server surfaces while preserving the continuity domain and the already-proven Windows POSIX shim, unless a concrete test proves a particular piece is still necessary.
