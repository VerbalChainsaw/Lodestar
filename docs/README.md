# Lodestar guides and contract

Start with [installation](installation.md) for Loader, Manager or CLI setup, then
use [operator and agent recipes](operator-recipes.md) for first project, capture,
resume, missing context, source review and uncertain saves.

| Need | Reference |
| --- | --- |
| See the product and choose an interface | [Product README](../README.md) |
| Install, upgrade or recover | [Installation and startup](installation.md) |
| Inspect Attention, capture and link evidence, or settle a save | [Operator and agent recipes](operator-recipes.md) |
| Interpret requirements, outcomes and context gaps | [Intent and evidence](intent-evidence.md) |
| Understand records, identity and storage | [Schema](schema.md) |
| Check supported guarantees | [Limitations](limitations.md) |
| Find common answers | [FAQ](../Q&A.md) |
| Diagnose an installation or command failure | [Troubleshooting](../HEADACHES.md) |
| Review 3.0 features and compatibility | [Release notes](releases/v3.0.0.md) |

For exact arguments and accepted write fields, use the installed typed reference:
`lodestar --help`, `lodestar <command> --help`, or native `lodestar_describe`.
Loader's Commands search and Manager's action finder expose the same declarations.
These guides explain the workflow; the installed reference owns command schemas.

## Shared implementation contract

Lodestar has one installed one-shot executable, one Windows-owned SQLite
database, one contract-5 JSON envelope, and one guarded mutation owner. The
one-shot core has no daemon, embedded hooks, App Server calls, session rotation,
startup cache, or private governance payload. An optional native host integration
owns the compaction hooks: it saves recorded work before compaction and restores
bounded Lodestar context afterward. The host owns hook delivery; the core remains
a one-shot record service.

`start`, `get`, `find`, and `links` are ordinary reads. They return project and
checkout identity, source observations, current records, conflicts, and the basis
needed for a later checked update. Work, decision, handoff, pending, generic put, and
retirement mutations all pass through the same receipt, precondition, transaction,
revision, and writer-fence path.

The Codex integration is a native skill plus MCP adapter. Its tool schemas import the
same command, mutation-input, request, and contract declarations as the CLI. The
adapter spawns the installed package for each call and owns no durable state.

The separate Windows Loader console and compatible menu Manager use this same core.
See [installation](installation.md), [schema](schema.md), [limitations](limitations.md),
and the [3.0.0 release notes](releases/v3.0.0.md). JSON command help exposes complete
mutation inputs. Ordinary local-source reads flag changed evidence without rewriting
saved observations; explicit canonical project mappings preserve usable correction paths.

Maintainers should use the [publishing guide](publishing.md) for package release,
landing-page deployment, and verification order.
