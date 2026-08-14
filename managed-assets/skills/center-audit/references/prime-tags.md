# CENTER-AUDIT: PRIME and Modern-System Tags

Use only tags that identify the causal mechanism or audit failure mode.

| Tag | Meaning |
|---|---|
| `[REALITY]` | Evidence versus assumption problem |
| `[AUTHORITY]` | Unsupported status, success, promotion, or permission claim |
| `[MODEL]` | Action or conclusion without verified understanding |
| `[MISSION]` | Scope drift or unauthorized expansion |
| `[REVERSIBILITY]` | Destructive or unrecoverable action risk |
| `[PERSISTENCE]` | Save/load/export/import/migration integrity risk |
| `[BOUNDARY]` | API/CLI/UI/event/network/filesystem/public contract risk |
| `[TEST]` | Missing, stale, wrong-target, or fake verification |
| `[MUTATION]` | Propagation from a prior stop; cite the originating stop/evidence |
| `[PROVENANCE]` | Revision, source, generator, data lineage, or evidence-origin problem |
| `[CONFIG]` | Environment, feature flag, precedence, policy, or binding problem |
| `[TEMPORAL]` | Ordering, retry, timeout, scheduling, cache lifetime, or lifecycle problem |
| `[CONCURRENCY]` | Race, atomicity, locking, cancellation, or shared-state problem |
| `[GENERATED]` | Generated/transpiled/source-map/codegen drift problem |
| `[AI]` | Prompt, model, retrieval, memory, parser, tool schema, or agent orchestration problem |

Tags do not determine severity. A `[BOUNDARY]` issue may be LOW or CRITICAL depending on confirmed impact.
