# Lodestar

<p align="center">
  <img
    src="https://raw.githubusercontent.com/VerbalChainsaw/Lodestar/main/docs/assets/lodestar-launch-hero.png"
    alt="Lodestar: local context, one database, one CLI, small by design"
    width="100%"
  />
</p>

<p align="center">
  <strong>A small, durable, machine-first local context registry.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/lodestar-agent-context"><img alt="npm version" src="https://img.shields.io/npm/v/lodestar-agent-context?style=flat-square"></a>
  <a href="https://github.com/VerbalChainsaw/Lodestar/actions/workflows/ci.yml"><img alt="cross-platform checks" src="https://img.shields.io/github/actions/workflow/status/VerbalChainsaw/Lodestar/ci.yml?branch=main&style=flat-square&label=checks"></a>
  <a href="https://github.com/VerbalChainsaw/Lodestar/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/lodestar-agent-context?style=flat-square"></a>
</p>

Lodestar stores compact, structured project knowledge in one local SQLite
database and retrieves it through stable IDs, exact aliases, bounded search,
and explicit links. JSON is the primary interface, so humans and agents use
the same predictable contract.

Lodestar does not inspect repositories, infer readiness, orchestrate agents,
run services, contact providers, or claim that its records fully describe a
project. A missing record means only that Lodestar lacks that knowledge.

## Why 1.0 is the better Lodestar

The original Lodestar proved that stable, structured project context was
useful. It also taught me where the product had become more complicated than
its job required.

I believe Lodestar 1.0 is the stronger product. It does less, but it does the
important part with a smaller contract and fewer custom mechanisms to operate,
debug, and maintain.

| Original Lodestar | Lodestar 1.0 |
| --- | --- |
| Generation trees, commit pointers, heartbeat locks, snapshots, and custom rollback | SQLite transactions and normal SQLite durability |
| Multiple executables and installer-specific behavior | One `lodestar` executable and no installer runtime |
| Project discovery, readiness scoring, and completeness claims | Direct records and source facts; unknown stays unknown |
| Provider experiments and agent-specific integration | Provider-neutral JSON with no orchestration layer |
| A required setup path before normal writes | The first valid `put` initializes the registry automatically |
| A broad context-management platform | A focused local registry with no runtime dependencies or background service |

The reduction did not throw away the parts that mattered. Lodestar keeps
deterministic behavior, structured JSON, explicit schemas, stable identifiers,
bounded inputs and outputs, careful paths, cross-platform support, actionable
diagnostics, atomic transactions, and honest uncertainty.

For the job Lodestar now claims—store, retrieve, relate, validate, and migrate
project context—1.0 is simpler to understand and safer to operate. It is the
version I recommend.

## Why Lodestar

Agents often start by recursively searching a repository and rebuilding
context that a project already knows. Lodestar gives them a smaller first
move:

- retrieve a known fact by stable ID or exact alias;
- follow explicit relationships instead of inferring them;
- distinguish known, empty, unavailable, unknown, and stale knowledge;
- fall back to normal repository inspection when the registry is insufficient.

The result is deliberately plain: one executable, one database, no background
service, no plugins, and no network requirement at runtime.

## Requirements

- Node.js 24.15.0 or newer
- no runtime dependencies
- no network connection at runtime

The package publishes one executable: `lodestar`.

## Install

```text
npm install --global lodestar-agent-context
lodestar --version
```

## Quick start

No setup command is required. The first valid `lodestar put` creates and
initializes the default database automatically. `lodestar import` likewise
creates its destination. `lodestar init` remains available when a caller
deliberately wants an empty registry or the bootstrap response.

Create `record.json`:

```json
{
  "id": "project:example:commands",
  "type": "command",
  "name": "Example project commands",
  "scope": "project:example",
  "content": {
    "state": "known",
    "value": {
      "test": "npm test"
    }
  },
  "aliases": [
    "example commands"
  ],
  "links": [],
  "sources": [
    {
      "origin": "package.json",
      "freshness": "current",
      "metadata": {
        "inspection": "inspected"
      }
    }
  ]
}
```

Then write and retrieve it:

```text
lodestar put --file record.json
lodestar get "example commands"
lodestar find commands --scope project:example
```

JSON is the default interface. Every successful command emits one object to
stdout:

```json
{
  "ok": true,
  "data": {}
}
```

Every failure emits one stable error object to stderr and exits nonzero:

```json
{
  "ok": false,
  "error": {
    "code": "record_not_found",
    "message": "No record or alias matched the requested identifier.",
    "identifiers": {
      "requested": "missing"
    },
    "action": "Use lodestar find or inspect the repository directly."
  }
}
```

Use `--human` for formatted output. Use `--db <path>` or `LODESTAR_DB` to
select a database explicitly.

## Commands

| Command | Purpose |
| --- | --- |
| `lodestar init` | Optionally create an empty schema and return the bootstrap contract. |
| `lodestar put` | Insert or replace one record, initializing on the first valid write. |
| `lodestar get <id-or-alias>` | Resolve an exact ID or alias. |
| `lodestar find <query>` | Return bounded, deterministically ordered summaries. |
| `lodestar links <id-or-alias>` | Return one hop of incoming and outgoing links. |
| `lodestar delete <id-or-alias>` | Delete a record and its dependent rows transactionally. |
| `lodestar doctor` | Check schema, SQLite integrity, foreign keys, and complete stored-value semantics. |
| `lodestar import <path>` | Import one v0.7-compatible store into an empty database. |
| `lodestar export` | Emit a deterministic JSON representation of the registry. |

Run `lodestar --help` or `lodestar <command> --help` for the bounded
machine-readable command contract. Help and version requests do not open or
create a database. Use `--` before a positional ID, alias, query, or path that
begins with two hyphens.

## Data model

The database contains exactly five tables:

- `records`: stable identity, type, name, scope, content, and timestamps
- `links`: directed relationships between existing records
- `aliases`: globally unique exact aliases
- `sources`: origin, freshness, and inspection facts
- `metadata`: schema version and database creation time

Record content must use one of five distinct states:

- `known`
- `known_empty`
- `unavailable`
- `unknown`
- `stale`

`known_empty` means a checked source supports an empty value. It does not mean
the project is complete. Source inspection is stored separately as
`inspected`, `not_inspected`, `inspected_no_value`, or `unknown`.

See [the schema contract](docs/schema.md) for the complete input shape and
bounds.

## Database location and durability

The default database is:

- Windows: `%LOCALAPPDATA%\Lodestar\lodestar.db`
- macOS: `~/Library/Application Support/Lodestar/lodestar.db`
- Linux/WSL: `$XDG_DATA_HOME/lodestar/lodestar.db`, or
  `~/.local/share/lodestar/lodestar.db`

Writes use `BEGIN IMMEDIATE`, foreign keys, a bounded busy timeout, SQLite's
rollback journal, and `synchronous=FULL`. Read commands use read-only,
query-only connections with in-memory temporary storage. New database files
are reserved without replacement before SQLite initializes them. A published
reservation is never removed as failure cleanup and a zero-byte reservation is
resumable, so one creator cannot delete another creator's completed database.
Lodestar does not add generations, lock heartbeats, snapshots, quarantine, or
a second persistence format around SQLite.

## Agent use

The package documents this short provider-neutral contract; optional
`lodestar init` also returns it:

1. Use Lodestar before recursively searching; the first put initializes it.
2. Retrieve records through stable IDs or aliases.
3. Follow explicit links for related context.
4. Treat a missing record as missing knowledge, not proof that nothing exists.
5. Inspect the repository normally when Lodestar is insufficient.

The identical machine-readable contract is in
[docs/agent-bootstrap.json](docs/agent-bootstrap.json). Lodestar does not
install or orchestrate an agent.

## Migrating from v0.7

Preview first:

```text
lodestar import /path/to/old/store --dry-run --db /path/to/lodestar.db
```

Review `skipped`, `unsupported`, `id_mappings`, and the `reporting` totals
before running the command without `--dry-run`. Report arrays are bounded; a
true `reporting.truncated` value identifies exact omitted-entry counts and is a
reason to keep the old store while resolving the omissions. The importer never
writes to the old store, does not merge into populated databases, and does not
provide dual-write compatibility. Keep the old store until representative
IDs, aliases, links, counts, `lodestar doctor`, and `lodestar export` have been
checked.

See [the v0.7 migration guide](docs/migration-v0.7.md).

## Boundaries

Lodestar is not a backup system, authorization boundary, repository search
engine, source-control system, database server, or completeness assessor. It
does not encrypt or authenticate a database. Protect and back up the file with
normal operating-system tools appropriate to the data.

The complete claim boundary is documented in
[docs/limitations.md](docs/limitations.md).

## Development

```text
npm test
npm run pack:check
```

The core is plain JavaScript using Node's built-in SQLite API. The architecture
and its deliberate deletions are recorded in the source repository's
architectural reduction report.

Lodestar is licensed under the [MIT License](LICENSE). Security reports should
follow [SECURITY.md](SECURITY.md).
