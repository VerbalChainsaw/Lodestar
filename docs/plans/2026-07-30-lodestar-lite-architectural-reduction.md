# LodestarLite architectural reduction report

Status: implemented and locally verified; hosted cross-platform CI pending push

Branch: `LodestarLite`

Baseline: `main` at `27d61c3c71ed1896b6ef0828e446bf959f96221f`

Date: 2026-07-30

## Decision

LodestarLite will be a local context registry backed by one SQLite database and
published through one executable named `lodestar`.

The runtime will store records, aliases, typed links, and source observations.
It will not inspect repositories, infer project readiness, orchestrate agents,
manage providers, run in the background, or implement storage and recovery
mechanisms already supplied by SQLite or the operating system.

This is a replacement of the v0.7.0 architecture, not a compatibility-preserving
refactor. The only compatibility component will be a one-way, read-only v0.7.0
importer.

Implementation began only after this report was accepted. The gate is retained
here as part of the decision record.

## Baseline evidence

The current package is `lodestar-agent-context@0.7.0`.

- `package.json` publishes 11 executable names.
- `agentctx --help` exposes 21 commands.
- The packed artifact contains 74 entries and 574,793 unpacked bytes.
- The shipped JavaScript in `agentctx.mjs`, `install.mjs`, `lib/`, and `tools/`
  is 14,969 lines.
- The current test suite is 7,088 lines and the documentation tree is 13,596
  lines.
- The current store is a directory hierarchy containing a mutable
  `current.json` pointer, immutable generation directories, JSON/JSONL source
  shards, generated indexes, integrity manifests, an audit chain, writer-lock
  state, backups, snapshots, and quarantine directories.

Those figures are repository measurements, not estimates.

## 1. Existing subsystem map and disposition

The disposition labels below are intentionally literal:

- **retain** means the user-visible responsibility survives.
- **reduce** means only a smaller directly useful part survives.
- **replace with SQLite or operating-system behavior** means the custom
  mechanism ceases to exist.
- **development-only** means it is never shipped in the package or exposed by
  the CLI.
- **delete** means it leaves this branch; git history remains the archive.

| Existing subsystem and principal files | Current responsibility | Classification | LodestarLite disposition |
| --- | --- | --- | --- |
| Package executable map (`package.json`) | Publishes `agentctx`, installers, migrations, and benchmark executables | reduce | Publish only `lodestar -> lodestar.mjs`. All other bin names cease to exist. |
| Main CLI (`agentctx.mjs`, `lib/cli-options.mjs`, `lib/main-entry.mjs`) | Parses and dispatches 21 commands | reduce | Replace with a small JSON-first dispatcher for nine commands and global help/version handling. |
| Error envelope (`lib/errors.mjs`, `ContextError`) | Converts failures to JSON | retain | Keep one small error module with stable code, message, identifiers, and optional corrective action. |
| State-home selection and initialization (`lib/state-home.mjs`, `lib/store-layout.mjs`) | Selects a home and creates a multi-directory store | reduce | Resolve one database path and create its parent only during `init`, import, or another write command. |
| Record CRUD in `ContextStore` (`lib/context-store.mjs`, `tools/tool-store.mjs`) | Reads and rewrites JSON/JSONL generations | reduce | Replace with plain transaction-scoped SQL functions for put, get, delete, aliases, links, and sources. The `ContextStore` class ceases to exist. |
| Startup packet and cards (`start`, `project`, `lib/cards.mjs`) | Infers current project and builds an agent packet | delete | No startup packet, project card, automatic current-project selection, or startup routing. |
| Recognized-intent queries (`ask`) | Maps a fixed intent vocabulary to readiness categories | delete | Agents query stable IDs, aliases, text, and explicit links directly. |
| Scope authorization and project-root inference (`lib/project-roots.mjs`, scoped parts of `ContextStore`) | Infers a project from cwd and limits visible records | delete | `scope` remains stored and filterable, but it is organization metadata, not an inferred authorization boundary. |
| Coverage/readiness (`coverage`, coverage code in `ContextStore`) | Computes complete, ready, stale, and blocked project states | delete | No category coverage, readiness score, or completeness claim survives. |
| Link traversal (`resolve`, `lib/resolve.mjs`) | Recursively builds a bounded graph | reduce | `links` returns one explicit incoming/outgoing edge set. Recursion belongs to the caller. |
| Generated route/search/locator indexes (`lib/indexes.mjs`) | Materializes JSON indexes per generation | replace with SQLite or operating-system behavior | Use primary keys, three ordinary SQL indexes, and bounded SQL queries. No FTS or generated index files initially. |
| Record/catalog/schema validation (`lib/validation.mjs`, `lib/resource-limits.mjs`, `lib/budgets.mjs`, `schema/store.json`) | Validates the broad v1 graph and resource budgets | reduce | Validate only the five-table contract, JSON envelopes, identifiers, timestamps, and explicit limits currently consumed by the CLI. |
| Canonical JSON and bounded input (`lib/canonical-json.mjs`, `lib/bounded-io.mjs`) | Stable serialization and byte-limited reads | retain | Keep small plain functions used by put, export, deterministic migration IDs, and the legacy reader. |
| Path confinement (`lib/safe-path.mjs`, `lib/native-path.mjs`) | Protects installers, snapshots, stores, and WSL/native mappings | reduce | Retain only database-path resolution and read-only importer confinement. Delete WSL path translation and publishing-directory machinery. |
| Immutable generations and commit pointer (`lib/generation.mjs`, generation portions of `lib/store-layout.mjs`) | Builds content-addressed trees and atomically promotes `current.json` | replace with SQLite or operating-system behavior | One SQLite transaction becomes the commit unit. Generations, hashes-as-generation-IDs, staging trees, and pointer promotion cease to exist. |
| Atomic and durable filesystem layer (`lib/atomic-file.mjs`, `lib/durable-fs.mjs`) | Implements replacement, fsync barriers, and platform fallbacks | replace with SQLite or operating-system behavior | SQLite owns its database and rollback journal. LodestarLite will not wrap SQLite commits in custom file operations. |
| Heartbeat writer lock (`lib/write-lock.mjs`) | Maintains owner nonce, heartbeat, stale-owner detection, and lock quarantine | replace with SQLite or operating-system behavior | SQLite locking plus a bounded busy timeout serializes writers. Owner heartbeats, stale-lock repair, and force recovery cease to exist. |
| Integrity manifests (`lib/integrity.mjs`) | Hashes every generation file and verifies manifests | replace with SQLite or operating-system behavior | Constraints, `integrity_check`, and `foreign_key_check` replace application manifests. No duplicate checksum tree is maintained. |
| Store doctor (`lib/doctor.mjs` and `ContextStore.doctor`) | Checks generations, locks, durability, indexes, roots, locators, and readiness | reduce | Check file identity, schema version/shape, SQLite integrity, foreign keys, JSON/state validity, and cross-table alias ambiguity. It performs no repair. |
| Snapshots and restore (`lib/snapshot.mjs`) | Copies and verifies generation and audit trees | delete | No runtime snapshot, restore, or snapshot hierarchy. Users use normal backup tooling outside Lodestar. |
| Maintenance, retention, audit rotation, quarantine, recovery (`lib/maintenance.mjs`) | Rotates audit files and moves/recover generations | delete | No maintenance command, application audit chain, generation retention, quarantine, or recover command. |
| Project discovery (`lib/discovery.mjs`) | Recursively finds projects from filesystem markers | delete | LodestarLite never recursively scans repositories. |
| Locator health (`lib/locator-health.mjs`) | Probes project files and records health in generated indexes | delete | Source inspection is an explicit fact supplied by a caller, not performed by the registry. |
| Project profiler and refresh (`tools/profile-projects.mjs`, `tools/refresh-projects.mjs`) | Shallow-scans projects and synthesizes context/readiness records | delete | No universal project-understanding or refresh subsystem. |
| Project-registry merger (`tools/migrate-projects.mjs`) | Imports an external portfolio and produces generated project records | delete | Generic registry merging and generated readiness records cease to exist. |
| Old flat-store migration (`tools/migrate-legacy.mjs`) | Converts a pre-generation format into v0.7 generations | delete | Replace it with one importer whose only source contract is a v0.7.0 store and whose only destination is the SQLite schema below. |
| Codex adapter (`tools/install-codex.mjs`, `tools/inventory-codex.mjs`, `tools/rollback-codex.mjs`) | Edits Codex files, inventories Codex state, and rolls back adapter writes | delete | No provider-specific runtime or installer behavior. |
| Installer ecosystem (`install.mjs`, `install.sh`, `install.ps1`) | Installs npm packages, shims, managed blocks, backups, and rollback state | delete | Distribution uses normal package-manager behavior. LodestarLite ships no installer or installer rollback framework. |
| Lift/performance benchmarks (`lib/lift-benchmark.mjs`, `lib/performance-benchmark.mjs`, `tools/benchmark-lift.mjs`, `tools/benchmark-performance.mjs`) | Measures old generation-store retrieval and performance claims | delete | These tests measure the architecture being removed and will not be carried forward or shipped. A future SQLite microbenchmark must justify itself independently and remain development-only. |
| Category benchmark (`lib/category-fixture.mjs`, `lib/category-harness.mjs`, `lib/category-score.mjs`, `tools/benchmark-category.mjs`, `benchmarks/`) | Runs paired agent/provider experiments | delete | The harness, fixture, scoring system, configuration, and public command cease to exist. |
| Codex and mock category runners (`tools/category-codex-runner.mjs`, `tools/category-mock-runner.mjs`) | Executes provider-specific and mock trials | delete | Provider experiments are outside the product and are not retained in this branch. |
| Catalog and bootstrap templates (`templates/`, `schema/category-benchmark-answer.json`) | Seeds a catalog/global rule and benchmark answer schema | delete | No catalog template or benchmark schema. The five-line agent contract is static documentation and init output, not a seeded knowledge record. |
| Unit/integration tests (`test/`, `test-support/`) | Proves both core behavior and every removed subsystem | development-only | Replace with focused database, CLI, importer, package-content, crash, help, and read-only tests. Tests are never packaged. |
| Product and architecture documentation (`README.md`, most of `docs/`) | Documents benchmarks, readiness, installers, generations, snapshots, and maintenance | reduce | Rewrite README for the registry. Delete obsolete architecture, benchmark, maintenance, installer, plan, and release pages from this branch; git tags retain history. Add only schema, limitations, bootstrap, and v0.7 import documentation. |
| Security, license, and changelog (`SECURITY.md`, `LICENSE`, `CHANGELOG.md`) | Project policy and history | retain | Keep the license and security policy; reduce the changelog to clearly separate the retired v0.x product from LodestarLite. |
| CI, CodeQL, and release workflows (`.github/`) | Tests and releases the existing package/installer matrix | development-only | Retain cross-platform tests, CodeQL, and package provenance after removing installer, snapshot, benchmark, and multi-bin gates. Update the Node baseline. |
| Checked-in package archives (`dist/*.tgz`, root `*.tgz`) | Stores obsolete release artifacts in source | delete | Remove them. Published tags/releases remain the source for historical artifacts. |

### What will cease to exist

The following names and concepts will not be aliases or hidden compatibility
paths:

- `agentctx`
- `start`, `resolve`, `project`, `coverage`, `ask`, `install-codex`,
  `rollback`, `inventory-codex`, `migrate-projects`, `migrate-legacy`,
  `profile-projects`, `refresh`, `snapshot`, `restore`, `maintain`, and
  `recover`
- state homes made of JSON/JSONL generations
- `current.json`
- generation IDs and immutable generation trees
- route, locator-health, and search-index files
- application integrity manifests
- audit JSONL chains
- writer-lock directories, owners, heartbeats, and stale-lock quarantine
- snapshot, backup, quarantine, and recovery directories
- automatic repository discovery, profiling, and readiness calculation
- project completeness and category-readiness language
- Codex installation, inventory, runner, and rollback behavior
- installer-managed npm shims and package rollback
- benchmark and provider-test executables
- every published executable except `lodestar`

## 2. Proposed final file and module structure

```text
lodestar.mjs
package.json
LICENSE
README.md
SECURITY.md
CHANGELOG.md

src/
  bootstrap.mjs
  cli.mjs
  database.mjs
  diagnostics.mjs
  doctor.mjs
  errors.mjs
  import-v070.mjs
  json.mjs
  legacy-v070/
    convert.mjs
    integrity.mjs
    mapping.mjs
    parse.mjs
    read.mjs
  paths.mjs
  queries.mjs
  records.mjs
  schema.mjs
  validate.mjs

test/
  cli.test.mjs
  database.test.mjs
  doctor.test.mjs
  import-v070.test.mjs
  json.test.mjs
  package.test.mjs
  queries.test.mjs
  records.test.mjs

docs/
  agent-bootstrap.json
  limitations.md
  migration-v0.7.md
  schema.md
  plans/
    2026-07-30-lodestar-lite-architectural-reduction.md
```

Responsibilities are direct:

- `lodestar.mjs` invokes the CLI and owns process exit behavior.
- `cli.mjs` parses bounded arguments, returns help without opening a database,
  dispatches commands, and renders JSON or explicit human output.
- `database.mjs` opens either a read-only or read-write connection and provides
  the transaction helper and no-replace initialization.
- `diagnostics.mjs` bounds untrusted identifiers used in errors, doctor issues,
  and migration reports.
- `schema.mjs` contains schema version 1 and its DDL. There is no generic
  migration framework.
- `records.mjs` implements put, get, alias resolution, and delete.
- `queries.mjs` implements bounded find, one-hop links, and export.
- `doctor.mjs` implements read-only database checks.
- `validate.mjs` owns the current input and knowledge-state contract.
- `json.mjs` owns canonical JSON and size measurement.
- `paths.mjs` resolves the database path and confines the legacy source.
- `import-v070.mjs` coordinates the one-way import transaction and report.
- `legacy-v070/read.mjs` confines, fingerprints, verifies, and parses the old
  generation without writing to it.
- `legacy-v070/integrity.mjs` verifies a present v0.7 integrity manifest and
  its bounded file set.
- `legacy-v070/mapping.mjs` maps legacy field, knowledge, scope, and source
  semantics while reporting lossy conversions.
- `legacy-v070/parse.mjs` performs strict UTF-8 JSON and bounded JSONL parsing.
- `legacy-v070/convert.mjs` coordinates deterministic IDs, alias ownership,
  and explicit link conversion.
- `bootstrap.mjs` contains the same tiny contract emitted by init and stored in
  `docs/agent-bootstrap.json`.
- `errors.mjs` is the only application error abstraction.

No application-defined classes are proposed. The runtime uses plain functions
and Node's SQLite connection object.

## 3. Proposed SQLite schema

The database contains exactly the four requested core tables plus one metadata
table. Ordinary indexes are not additional conceptual stores.

```sql
CREATE TABLE metadata (
  key TEXT PRIMARY KEY
    CHECK(length(CAST(key AS BLOB)) BETWEEN 1 AND 64),
  value TEXT NOT NULL
    CHECK(length(CAST(value AS BLOB)) BETWEEN 1 AND 4096)
) STRICT, WITHOUT ROWID;

CREATE TABLE records (
  id TEXT PRIMARY KEY
    CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 256),
  type TEXT NOT NULL
    CHECK(length(CAST(type AS BLOB)) BETWEEN 1 AND 64),
  name TEXT NOT NULL
    CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 256),
  scope TEXT NOT NULL
    CHECK(length(CAST(scope AS BLOB)) BETWEEN 1 AND 512),
  content_json TEXT NOT NULL
    CHECK(
      length(CAST(content_json AS BLOB)) <= 262144
      AND CASE WHEN json_valid(content_json) THEN (
        json_type(content_json) = 'object'
        AND json_type(content_json, '$.state') = 'text'
        AND json_extract(content_json, '$.state')
          IN ('known', 'known_empty', 'unavailable', 'unknown', 'stale')
      ) ELSE 0 END
    ),
  created_at TEXT NOT NULL
    CHECK(
      length(CAST(created_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at,
        0
      )
    ),
  updated_at TEXT NOT NULL
    CHECK(
      length(CAST(updated_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at,
        0
      )
    )
) STRICT, WITHOUT ROWID;

CREATE TABLE links (
  from_id TEXT NOT NULL
    REFERENCES records(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL
    CHECK(length(CAST(relationship AS BLOB)) BETWEEN 1 AND 64),
  to_id TEXT NOT NULL
    REFERENCES records(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
    CHECK(
      length(CAST(created_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at,
        0
      )
    ),
  PRIMARY KEY (from_id, relationship, to_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE aliases (
  alias TEXT PRIMARY KEY
    CHECK(length(CAST(alias AS BLOB)) BETWEEN 1 AND 256),
  record_id TEXT NOT NULL
    REFERENCES records(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE sources (
  record_id TEXT NOT NULL
    REFERENCES records(id) ON DELETE CASCADE,
  origin TEXT NOT NULL
    CHECK(length(CAST(origin AS BLOB)) BETWEEN 1 AND 4096),
  freshness TEXT NOT NULL
    CHECK(freshness IN ('current', 'stale', 'unknown')),
  metadata_json TEXT NOT NULL
    CHECK(
      length(CAST(metadata_json AS BLOB)) <= 65536
      AND CASE WHEN json_valid(metadata_json) THEN (
        json_type(metadata_json) = 'object'
        AND json_type(metadata_json, '$.inspection') = 'text'
        AND json_extract(metadata_json, '$.inspection')
          IN ('inspected', 'not_inspected', 'inspected_no_value', 'unknown')
      ) ELSE 0 END
    ),
  PRIMARY KEY (record_id, origin)
) STRICT, WITHOUT ROWID;

CREATE INDEX records_scope_type_id
  ON records(scope, type, id);

CREATE INDEX links_to_id
  ON links(to_id, relationship, from_id);

CREATE INDEX aliases_record_id
  ON aliases(record_id, alias);
```

`metadata` initially contains only:

```json
{
  "schema_version": "1",
  "created_at": "<RFC3339 UTC timestamp>"
}
```

An unknown schema version is rejected with `unsupported_schema`; it does not
trigger a speculative migration framework.

### Knowledge-state contract

`content_json` is canonical JSON with this envelope:

```json
{
  "state": "known",
  "value": {
    "test_command": "npm test"
  },
  "reason": "optional direct evidence or limitation"
}
```

The states mean:

- `known`: a value is asserted.
- `known_empty`: a source was checked and the asserted result is empty.
- `unavailable`: the intended source could not be accessed.
- `unknown`: no supported assertion is available.
- `stale`: a prior value is retained but explicitly marked potentially out of
  date.

Missing records are returned as `record_not_found` and described as missing
knowledge. They are never converted into a completeness claim.

Source inspection and freshness are separate. `inspection: "unknown"` is used
when the registry lacks evidence; absence of inspection metadata is never
silently interpreted as `not_inspected`.

### Identity, aliases, and links

- IDs and aliases are exact, case-sensitive UTF-8 strings after NFC validation.
- An exact record ID is resolved before an alias.
- Put rejects an alias that equals any record ID and rejects a new record ID
  that equals an existing alias. Doctor checks this invariant as well.
- Aliases are globally unique.
- Relationships are explicit short names such as `depends_on`, `documents`, or
  `related`.
- Links are directed. `lodestar links` reports incoming and outgoing edges.
- IDs are immutable. Changing an ID means creating the new record and deleting
  the old one deliberately.

### SQLite connection and durability policy

- Runtime baseline: Node.js `>=24.15.0`.
- Runtime dependencies: zero; use `node:sqlite`.
- Extensions are disabled.
- Foreign keys are enabled on every connection.
- Writers use `PRAGMA synchronous = FULL`, SQLite's default rollback-journal
  mode, a five-second busy timeout, and `BEGIN IMMEDIATE`.
- WAL is not enabled initially. The registry is write-light, and rollback mode
  avoids persistent `-wal` and `-shm` sidecars while retaining SQLite's normal
  atomic-commit behavior.
- Read commands open with `readOnly: true` and `query_only = ON`. They do not
  create the database, parent directories, journals, or metadata; temporary
  query storage remains in memory.
- A new database target is reserved with no-replace creation before SQLite
  initialization, so concurrent creators do not overwrite one another.
- Help and version handling complete before database-path resolution.

Node 24 exposes read-only connections, busy timeouts, foreign-key enforcement,
defensive mode, and resource limits directly in `DatabaseSync`. The API is
release-candidate status rather than fully stable, so the exact minimum Node
minor is pinned and exercised on Windows, macOS, and Linux:
<https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html>

SQLite supplies the atomic commit and rollback behavior replacing the custom
generation stack:
<https://sqlite.org/atomiccommit.html>

Doctor uses both integrity and foreign-key checks because SQLite documents them
as distinct checks:
<https://www.sqlite.org/pragma.html>

### Bounds

Initial hard limits are deliberately visible:

| Resource | Limit |
| --- | ---: |
| Put JSON input | 1 MiB |
| One CLI argument / all CLI arguments | 16 KiB / 64 KiB |
| Database or input path | 16 KiB |
| JSON nesting / structural nodes | 128 levels / 100,000 nodes |
| One canonical `content_json` | 256 KiB |
| One source `metadata_json` | 64 KiB |
| Aliases per record | 64 |
| Outgoing links per record | 256 |
| Sources per record | 32 |
| Record ID or alias | 256 UTF-8 bytes |
| Find query | 512 UTF-8 bytes |
| Find results | default 20, maximum 100 |
| Link results | default 100, maximum 500 |
| Registry records | 100,000 |
| JSON export | 64 MiB |
| Encoded command output | 80 MiB |
| Legacy import input | 100,000 records and 128 MiB total accepted source data |
| Migration details | 2,000 entries per section, 4 KiB per entry |

Limit failures use a stable `resource_limit` error and identify the measured and
maximum values. These constants may be adjusted from evidence, but they do not
become a configuration subsystem.

## 4. Final CLI

```text
lodestar init
lodestar put
lodestar get <id-or-alias>
lodestar find <query>
lodestar links <id-or-alias>
lodestar delete <id-or-alias>
lodestar doctor
lodestar import <v0.7-store-path>
lodestar export
```

Global options:

```text
--db <path>     override LODESTAR_DB and the platform data-directory default
--human         request human-oriented text instead of JSON
--help          return help without opening or creating a database
--version       return version without opening or creating a database
```

The default database is located in the platform's normal per-user data
directory, not the old `~/.lodestar` v0.7 home:

- Windows: `%LOCALAPPDATA%\Lodestar\lodestar.db`
- macOS: `~/Library/Application Support/Lodestar/lodestar.db`
- Linux/WSL: `$XDG_DATA_HOME/lodestar/lodestar.db`, falling back to
  `~/.local/share/lodestar/lodestar.db`

This separation prevents initialization or migration from adding files to the
legacy source tree. A user who wants one database shared across environments
sets `LODESTAR_DB` explicitly.

### Command contracts

`init`

- Creates the parent directory and schema only when absent.
- Is idempotent for a valid version-1 database.
- Refuses a non-Lodestar or unsupported database.
- Returns the resolved database path, schema version, creation status, and tiny
  agent bootstrap contract.

`put`

- Reads one JSON object from stdin by default; `--file <path>` is the only input
  convenience flag.
- Accepts `id`, `type`, `name`, `scope`, `content`, and optional complete arrays
  named `aliases`, `links`, and `sources`.
- Treats omitted arrays as empty.
- Inserts or replaces the record and its aliases, outgoing links, and sources
  in one transaction. Incoming links from other records are preserved.
- Preserves `created_at` on replacement and sets `updated_at` on a successful
  write.
- Rejects missing link targets or alias conflicts; it does not create implicit
  records.

Example input:

```json
{
  "id": "project:lodestar:commands",
  "type": "command",
  "name": "Lodestar commands",
  "scope": "project:lodestar",
  "content": {
    "state": "known",
    "value": {
      "test": "npm test"
    }
  },
  "aliases": [
    "lodestar commands"
  ],
  "links": [
    {
      "relationship": "documents",
      "to_id": "project:lodestar"
    }
  ],
  "sources": [
    {
      "origin": "package.json",
      "freshness": "current",
      "metadata": {
        "inspection": "inspected",
        "inspected_at": "2026-07-30T00:00:00.000Z"
      }
    }
  ]
}
```

`get`

- Resolves exact ID first, then exact alias.
- Returns the full record, aliases, outgoing links, and sources in deterministic
  order.
- Does not recursively fetch linked records.

`find`

- Supports `--scope`, `--type`, and `--limit`.
- Searches ID, alias, type, name, scope, and canonical content text with one
  bounded SQL query.
- Orders exact ID/alias matches first, then exact names, then prefixes, then
  substrings; every tie is ordered by binary record ID.
- Returns compact record summaries rather than unbounded content.
- Does not inspect the filesystem or use FTS in version 1.

`links`

- Resolves an ID or alias and returns explicit incoming and outgoing edges with
  compact peer summaries.
- Supports `--limit` and reports `truncated: true` when more edges exist.
- Performs no recursive traversal.

`delete`

- Deletes one resolved record in a transaction.
- SQLite cascades its aliases, sources, and all incoming/outgoing links.
- Returns the resolved ID and deleted row counts.
- A missing target is an error rather than a successful no-op.

`doctor`

- Opens the database read-only.
- Checks the expected schema version and exact table/index definitions,
  rejecting extra views or triggers as well.
- Runs bounded `integrity_check` and `foreign_key_check`.
- Checks JSON envelopes, knowledge states, timestamps, ownership limits, and ID/alias
  ambiguity.
- Reports facts and suggested action; it never repairs or mutates.

`import`

- Is exclusively the one-way v0.7.0-store importer described below.
- Supports `--dry-run`, which builds and validates an in-memory destination and
  performs no destination write.
- Refuses a nonempty destination. It is not a general merge command.

`export`

- Opens the database read-only.
- Emits one canonical JSON document containing schema version and all records,
  aliases, links, and sources ordered by their primary keys.
- Includes no export timestamp, random value, host identity, or path-dependent
  data.
- Fails before exceeding the export bound.

### JSON and error output

JSON is the default for commands and command help. `--human` is explicit.
Successful commands emit one document to stdout:

```json
{
  "ok": true,
  "data": {}
}
```

Failures emit one document to stderr and use a nonzero exit code:

```json
{
  "ok": false,
  "error": {
    "code": "record_not_found",
    "message": "No record or alias matched the requested identifier.",
    "identifiers": {
      "requested": "project:missing"
    },
    "action": "Use lodestar find or inspect the repository directly."
  }
}
```

Arrays and object keys emitted by Lodestar are canonicalized. Diagnostics and
warnings never contaminate stdout.

### Agent bootstrap

There is no bootstrap command and no provider installer. `init` returns this
versioned object, and the package documents the identical object in
`docs/agent-bootstrap.json`:

```json
{
  "version": 1,
  "instructions": [
    "Use Lodestar before recursively searching a project.",
    "Retrieve records through stable IDs or aliases.",
    "Follow explicit links for related context.",
    "Treat a missing record as missing knowledge, not proof that nothing exists.",
    "Inspect the repository normally when Lodestar is insufficient."
  ]
}
```

## 5. One-way v0.7.0 migration plan

### Source detection and read-only boundary

1. Resolve and realpath the supplied source directory.
2. Require a bounded `current.json` with a valid 64-character generation ID.
3. Resolve `generations/<id>` and verify that every expected source path remains
   inside that generation without following a symlink outside it.
4. Read only `catalog.json`, `schema/store.json`, `records/global.jsonl`,
   catalog-declared project shards, optional `indexes/locator-health.json`, and
   `integrity.json` when present.
5. Reject a destination database, journal, or other SQLite sidecar path that
   would be inside the source tree. Reject an existing destination with more
   than one hard link so a path outside the tree cannot alias a source file.
6. Never open a source file with write flags and never create a file, lock,
   report, or database under the source directory.
7. Fingerprint the accepted source files before and after conversion. A change
   aborts the import as `source_changed`.

A valid integrity manifest is verified. A missing manifest is reported as
`unsealed` rather than treated as verified because a v0.7 runtime can still
point at a generation created before sealing was introduced. A present but
invalid manifest is fatal.

The generation schema stores `v: 1`, not the npm runtime version that wrote it.
The importer can therefore prove a v0.7-compatible generation layout but cannot
infer an exact package version from the store alone. The report records
`version_evidence: "compatible_layout"` unless direct version evidence is
present; it never fabricates `0.7.0`.

### Deterministic conversion

All source items are sorted by canonical source location and identifier before
conversion.

| v0.7.0 input | SQLite output |
| --- | --- |
| Catalog project | A `type: "project"` record. Preserve the project ID and name; use `scope: "global"`; retain roots, aliases, stack, commands, and status in content. |
| Global or project record | A record whose type is the old `kind`. Preserve ID. Derive missing name from `name`, then `summary`, then first alias, then ID. |
| One-element scope array | Preserve its sole value as the scalar scope. |
| Multi-scope array | Select `global` when present, otherwise the binary-smallest scope; preserve the full array in legacy content and report `multi_scope_collapsed` as unsupported semantics. |
| `none_verified: true` | Use `state: "known_empty"` and preserve the old payload as evidence. |
| Other valid old record | Use `state: "known"` unless the old payload explicitly marks it stale, unavailable, or unknown. No age threshold is inferred. |
| Old `aliases` | Alias rows. Conflicts are skipped and reported; ownership is never guessed. |
| Old untyped `links` | Directed `related` links. |
| Old `routes` entries | Directed links named `route:<route-name>`. |
| Old `locators` | Source rows keyed by locator path, up to the source limit. |
| Locator-health index | Preserve exact path-probe observations without claiming that file content was inspected. |
| `ownership`, `generated_by`, `source_key`, and `verified` | Source metadata, together with generation and source-file location. |
| `verified` evidence | `inspection: "inspected"` or `inspected_no_value`; freshness remains `unknown` unless the old payload contains an explicit freshness assertion. |
| No inspection evidence | `inspection: "unknown"`, never `not_inspected`. |
| Invalid or absent source ID | `legacy:<32 lowercase hex>` from SHA-256 of the canonical generation ID and relative source location. |

The converter inserts all records first, then aliases and sources, then links,
so a valid forward reference does not depend on source-file order. Invalid
targets, alias collisions, duplicate source IDs, and unrepresentable values are
not silently repaired; they are skipped or mapped according to the table above
and represented by bounded report entries and exact omission counts.

### Destination transaction

- `--dry-run` creates schema version 1 in memory, performs the complete
  conversion, runs doctor checks, and emits the report.
- A real import reserves a missing destination without replacement or accepts
  an existing empty, singly linked version-1 destination.
- A destination containing any records is rejected. There is no merge,
  overwrite, dual write, or resume state machine.
- Schema creation and all imported rows are committed in one transaction.
- Any fatal conversion, constraint, pre-commit integrity, or source-change
  failure rolls back the transaction.
- After commit, the importer reopens the destination read-only and runs the
  same doctor checks before reporting success.
- If that post-commit reopen detects a new failure, the error explicitly
  reports `committed: true`; the importer never pretends it can roll back an
  already committed SQLite transaction.
- If SQLite does not confirm the commit outcome, the importer preserves the
  destination and reports `committed: "unknown"` for read-only diagnosis.

### Migration report

The report is one bounded JSON document:

```json
{
  "ok": true,
  "data": {
    "dry_run": false,
    "source": {
      "format": "lodestar-v0.7-compatible",
      "version_evidence": "compatible_layout",
      "generation": "<generation-id>",
      "integrity": "verified",
      "unchanged": true
    },
    "destination": {
      "schema_version": 1,
      "committed": true
    },
    "imported": {
      "records": 0,
      "aliases": 0,
      "links": 0,
      "sources": 0
    },
    "skipped": [],
    "unsupported": [],
    "id_mappings": [],
    "reporting": {
      "items_per_section_maximum": 2000,
      "item_bytes_maximum": 4096,
      "truncated": false,
      "sections": {
        "skipped": {
          "entries_total": 0,
          "entries_reported": 0,
          "entries_omitted": 0
        }
      }
    },
    "validation": {
      "integrity_check": "ok",
      "foreign_key_violations": 0,
      "doctor_ok": true
    }
  }
}
```

Each emitted skipped or unsupported entry contains its kind, source
identifier/location, reason code, and disposition. `id_mappings` contains only
generated or changed IDs. The `reporting` object makes truncation explicit and
preserves exact emitted and omitted entry counts; oversized legacy collections
may use one aggregate entry with their item count.

### User validation before discarding v0.7

1. Run `lodestar import <old-home> --dry-run`.
2. Review skipped and unsupported details plus every `reporting` total; do not
   discard the source while `reporting.truncated` remains unresolved.
3. Run the real import into an empty destination.
4. Run `lodestar doctor`.
5. Save `lodestar export` and the migration report.
6. Compare important record counts and retrieve representative stable IDs and
   aliases.
7. Archive or delete the old store only by an explicit user action outside
   LodestarLite.

LodestarLite never deletes, renames, marks, locks, or otherwise mutates the old
store.

## 6. Risks created by deletion

| Deleted mechanism | Resulting risk | Explicit boundary or mitigation |
| --- | --- | --- |
| Immutable generation history | There is no built-in historical version or application rollback. | Use ordinary backups or version-controlled exports. Lodestar promises current registry state, not history. |
| Integrity manifests | SQLite may detect corruption without reconstructing the prior value. | Doctor reports integrity failures and recommends restoring an external backup. It never claims repair. |
| Writer heartbeat and owner diagnostics | A busy database reports contention without naming an owner or reclaiming a lock. | SQLite serializes writers and the CLI returns `database_busy` after a bounded timeout. |
| Snapshots and restore | Users lose a Lodestar-specific backup workflow. | Document safe external backup/export practices. Do not recreate a backup product in core. |
| Audit chain | The registry no longer proves who changed a record or when beyond row timestamps. | Auditability is not a version-1 guarantee. Callers that require it keep their own logs. |
| Quarantine and recovery | Lodestar cannot isolate or promote damaged historical generations. | SQLite rollback handles interrupted transactions; corruption is diagnosed, not hidden or auto-repaired. |
| Discovery and profiling | Context no longer appears automatically from a repository. | This is intentional. Records are explicit, and missing knowledge triggers normal repository inspection. |
| Current-project inference and scope authorization | A caller can query another scope if it knows the ID. | LodestarLite is a local registry, not a security boundary. Use `--scope` to organize search, not authorize it. |
| Readiness and coverage | There is no summary declaring a project ready or complete. | Direct state and source facts are the replacement, not a weaker readiness score. |
| FTS/generated indexes | Substring search can slow as the registry approaches its hard size bound. | Keep deterministic bounded SQL in version 1. Add FTS only after measured need, with a concrete current consumer. |
| Provider installer | Agents do not receive automatic Codex configuration. | Publish the five-line provider-neutral bootstrap for users or tools to place where appropriate. |
| Installer ecosystem | Installation loses custom rollback and Windows shim repair. | Use the standard package manager and its generated `lodestar` shim. Cross-platform package tests remain. |
| Node 22 support | The zero-dependency SQLite choice raises the runtime baseline. | Require Node 24.15+ and test the exact supported LTS line on all three operating systems. |
| `node:sqlite` release-candidate API | A future Node minor could change a binding detail. | Use only the small documented `DatabaseSync` surface, pin the minimum minor, and keep database logic isolated in one module. |
| WAL not enabled | Concurrent read/write throughput is lower than a tuned service database. | Lodestar is a small local CLI, not a service. Prefer the simpler journal policy until actual contention proves otherwise. |
| One database file | File loss can remove all registry knowledge at once. | Document external backup/export. Do not disguise this with an in-core second storage engine. |

## 7. Guarantees retained after simplification

LodestarLite will guarantee:

1. One documented SQLite database is the only source of truth.
2. One published executable, `lodestar`, is the entire public runtime surface.
3. No command needs network access or a background process.
4. A put or delete either commits completely or rolls back completely in one
   SQLite transaction.
5. Foreign keys prevent committed dangling aliases, links, and sources.
6. Stable IDs are preserved by ordinary updates; alias resolution is exact and
   deterministic.
7. Search and link results are bounded and have documented total ordering.
8. Every command and error has a stable JSON envelope; human text is opt-in.
9. Inputs, stored JSON, import work, query results, and exports have explicit
   bounds.
10. Read-only commands use read-only SQLite connections and do not create files,
    directories, journals, or metadata.
11. `--help` and `--version` do not resolve, open, initialize, or mutate a
    database.
12. Doctor can detect unsupported schemas, SQLite integrity errors, foreign-key
    violations, malformed knowledge envelopes, and alias ambiguity.
13. The legacy importer never writes within its source and reports imported
    counts, bounded skipped/unsupported/remapped details, and exact omitted
    report-entry counts.
14. Known, known-empty, unavailable, unknown, and stale remain distinct in
    stored and emitted data.
15. Missing data is described as missing knowledge, never as evidence of
    completeness.
16. Database paths and importer paths behave consistently on Windows, macOS,
    Linux, and WSL.
17. Package contents contain no benchmark, provider, installer, plugin,
    orchestration, readiness, or background-service framework.

These guarantees do not include recovery from faulty storage hardware,
malicious modification of the database file, historical rollback, automatic
project understanding, or completeness of the knowledge supplied by users.

## 8. Estimated source-line reduction

Measured current shipped JavaScript:

```text
agentctx.mjs + install.mjs + lib/*.mjs + tools/*.mjs = 14,969 lines
```

Preimplementation target:

| Area | Estimated lines |
| --- | ---: |
| Executable, CLI, output, help | 350-450 |
| Database open/init/transactions/schema | 300-400 |
| Record validation and bounded JSON/path helpers | 350-500 |
| Put/get/delete/alias/link/source operations | 350-500 |
| Find/links/export queries | 300-450 |
| Doctor and bootstrap | 200-300 |
| Errors and shared constants | 100-150 |
| **Core subtotal** | **1,950-2,750** |
| One-way v0.7 importer across responsibility-based modules | 550-800 |
| **Total shipped JavaScript** | **2,500-3,550** |

Expected reduction:

- 11,419 to 12,469 shipped JavaScript lines removed.
- 76% to 83% total shipped JavaScript reduction.
- The core, excluding the importer, remains comfortably below the 4,000-line
  design pressure.
- Tests and documentation are excluded from both target figures.

The estimate is intentionally a range. It is a guardrail against reintroducing
frameworks, not an incentive to compress code.

### Implemented result

Measured after phases 1 through 5:

| Area | Actual lines |
| --- | ---: |
| Core `src/` modules excluding the legacy importer | 3,545 |
| `lodestar.mjs` executable | 5 |
| Import coordinator and isolated `legacy-v070/` modules | 2,031 |
| **Total shipped JavaScript** | **5,581** |

The core is 3,550 lines including the executable, below the
4,000-line design pressure. No runtime file exceeds 500 lines.

Relative to the 14,969-line v0.7 shipped-JavaScript baseline, 9,388 lines were
removed, a 62.7% reduction. The total is above the original estimate because
the adversarial pass retained explicit sealed-store verification, physical
path confinement, hard read/report bounds, source-change detection, exact
v0.7 shard compatibility, locator-source mapping, and deterministic loss
reporting. That complexity is isolated from all operational commands and has
one current consumer.

The packed artifact fell from 74 to 28 entries and from 574,793 to 177,980
unpacked bytes, a 69.0% byte reduction. The final tarball is 43,066 bytes.

The adversarially expanded suite passes 51 tests on exact Node.js 24.15.0.
The installed final tarball exercised all nine commands and ten help contracts;
hashing proved its read-only commands did not change the database. A sealed
store produced by the actual v0.7.0 checkout passed dry-run, committed import,
doctor, and alias retrieval while content and tree hashes proved the source
unchanged. The retained GitHub workflows repeat tests and packed smoke on
Windows, macOS, and Linux after the branch is pushed.

## 9. Complexity that must remain

Only the following areas justify nontrivial code:

1. **SQLite connection modes and transactions.** Read commands must be provably
   non-mutating, writes must be atomic, contention must be bounded, and schema
   versions must fail closed. This directly protects user data.
2. **Input and semantic validation.** IDs, aliases, relationships, knowledge
   states, source observations, JSON byte sizes, and collection counts cross a
   machine interface and require precise actionable errors.
3. **Deterministic querying and serialization.** Stable ordering, canonical
   JSON, exact alias precedence, bounded output, and deterministic legacy IDs
   are observable product guarantees.
4. **The v0.7.0 importer.** It must safely read a multi-file legacy tree,
   confine paths, verify available integrity evidence, preserve semantics,
   report loss, and prove the source was not changed. This is isolated
   complexity with a current migration consumer.
5. **Doctor.** SQLite structural integrity, foreign keys, application schema,
   and knowledge-envelope semantics are distinct checks. Reporting them
   accurately is worth a small dedicated module.
6. **Cross-platform database-path handling.** Default data directories and
   explicit overrides differ by operating system, and read commands must not
   create missing paths.
7. **CLI/error discipline.** Help must be side-effect free, stdout must contain
   exactly one deterministic result, and failures must retain stable codes and
   useful identifiers.

None of these justifies a plugin system, repository scanner, state machine,
background worker, generic storage abstraction, provider adapter, or
application-level durability protocol.

## 10. Implementation gate and order

After acceptance of this report, implementation proceeds in the requested
order:

1. Minimal database kernel: schema, open modes, transactions, records, links,
   aliases, sources, validation, and errors.
2. Minimal CLI: init, put, get, find, links, delete, doctor, and export.
3. One-way v0.7.0 importer and machine-readable validation report.
4. Static five-line agent bootstrap and concise limitations/migration docs.
5. Actual deletion of the old architecture, package-surface verification,
   cross-platform tests, help side-effect tests, and read-only no-write tests.

There will be no interval in which both storage engines are live behind the
public CLI. The importer may read v0.7.0, but every operational command will use
SQLite only.
