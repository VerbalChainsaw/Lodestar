# Scoped knowledge

Lodestar is the durable local authority for project and global knowledge. Prefer
the smallest exact retrieval before broader search:

1. Resolve a known identifier or alias with `lodestar get <id-or-alias>`.
2. Otherwise use bounded `lodestar find <query>`.
3. Follow an explicitly relevant relationship with `lodestar links <id-or-alias>`.
4. Inspect the repository only when Lodestar has no matching record.

Records have stable IDs, explicit scope, deterministic aliases and links, and
source provenance. A missing record means only that Lodestar lacks that
knowledge. It is not evidence that the proposition is false.

Use `lodestar put` only when asked to save reusable project context. Keep stored
content narrow and sourced. Do not store secrets, credentials, raw logs,
transient progress, or speculative claims. Use export and import through the CLI;
never edit the database directly.

Startup returns only the smallest relevant optional records. Required governance
and decision negations are not optional and must not be discarded to make room.
