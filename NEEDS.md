# Lodestar product scope

This document defines the public design boundary for Lodestar 2.1.2. For behavior and recovery details, see [installation](docs/installation.md), [schema and contract 5](docs/schema.md), and [limitations](docs/limitations.md).

## What Lodestar owns

Lodestar is a local, single-user project context system with:

- one installed, one-shot `lodestar` executable;
- one SQLite database and one contract-5 JSON success/error envelope;
- project and checkout orientation, evidence-backed records, decisions, work state, pending candidates, and handoff records;
- guarded mutations with explicit preconditions, one accepted revision, preserved history, and idempotent request receipts;
- read-only diagnosis, export, source freshness checks, and one explicit schema-4 to schema-5 conversion;
- explicit `setup` installation for maintained native skill payloads and selected launchers; and
- a Codex-native skill and MCP adapter whose supported tools are `lodestar_describe`, `lodestar_read`, and `lodestar_mutate`.

CLI and native tools share the same command declarations and mutation schemas. Application-owned record data stays application-owned; Lodestar stores and retrieves it without claiming that the prose is true.

## Required boundaries

Lodestar remains a one-shot local program. The current product does not own:

- a daemon, background service, discovery server, health endpoint, or idle lifecycle;
- host governance files, provider credentials, model settings, or authentication;
- Codex hooks, Codex App Server calls, thread creation, or automatic session rotation;
- automatic semantic search, remote-source refresh, or inference that missing data is false;
- direct WSL access to the SQLite file; or
- an atomic transaction spanning an external action and a later Lodestar update.

`setup` installs selected owned skill trees and launchers with receipts, retained backups, and interruption recovery. It does not rewrite `AGENTS.md`, host configuration, plugins, credentials, or private governance.

## Compatibility requirements

- Node.js 24.15.0 or newer is required.
- Current runtime reads and writes schema 5.
- Schema 4 has one explicit preserving conversion. Other historical schemas need an inspected, purpose-built preservation mapping rather than an assumed upgrade.
- Windows owns the SQLite process boundary for Windows/WSL use. WSL operations invoke Windows Node through the installed one-shot launcher.
- Installed files, package tests, and native discovery do not prove that a model invoked Lodestar. Host authentication and model behavior remain separate checks.

## Standard for future changes

A proposed feature belongs in Lodestar only when it strengthens the existing local context, evidence, continuity, installation, or recovery contract without creating a second state owner. Public command and schema changes need shared CLI/native declarations, guarded persistence where state changes, recoverable errors, and documentation of compatibility consequences.

Requests that require a service, host control plane, provider integration, session orchestration, or a competing database should remain outside Lodestar unless the product boundary is deliberately changed and the replacement is simpler and safer than the current one-shot model.

There are no unpublished tools or machine-specific setup steps required to use the public 2.1.2 package. Current operational problems belong in [troubleshooting](HEADACHES.md); confirmed product limits belong in [limitations](docs/limitations.md).
