# Lodestar 2.0 implementation contract

Lodestar 2.0 has one installed one-shot executable, one Windows-owned SQLite
database, one contract-5 JSON envelope, and one guarded mutation owner. The current
runtime has no daemon, hooks, App Server calls, session rotation, startup cache, or
private governance payload.

`start`, `get`, `find`, and `links` are ordinary reads. They return project and
checkout identity, source observations, current records, conflicts, and the basis
needed for a later checked update. Work, decision, handoff, pending, generic put, and
retirement mutations all pass through the same receipt, precondition, transaction,
revision, and writer-fence path.

The Codex integration is a native skill plus MCP adapter. Its tool schemas import the
same command, mutation-input, request, and contract declarations as the CLI. The
adapter spawns the installed package for each call and owns no durable state.

See [schema](schema.md), [limitations](limitations.md), and the
[2.0.0 release notes](releases/v2.0.0.md).
