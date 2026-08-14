# Lodestar schema version 3

One Windows-owned SQLite database is the source of truth for every Lodestar
capability. Schema version 3 uses one universal record model:

```text
metadata(key, value)
records(id, type, name, scope, content_json, created_at, updated_at)
links(from_id, relationship, to_id, created_at)
aliases(alias, record_id)
sources(record_id, origin, freshness, metadata_json)
```

The exact DDL is defined in `src/schema.mjs`. Tables are `STRICT` and
`WITHOUT ROWID`. Knowledge, project identity, advisory work, and handoff state
are record kinds; they do not have parallel durable tables.

## Revisions

Metadata contains a nonnegative `database_revision`. Every successful record
mutation allocates its next positive integer inside the same `BEGIN IMMEDIATE`
transaction as the write and stores that value in the record's private
`_lodestar.revision` metadata. Revisions—not timestamps—define write order.
Deletion also allocates and returns a revision.

## Put input

`lodestar put` accepts either the established record shape or the normalized
version-1 record shape. The established shape is:

```json
{
  "id": "project:example:commands",
  "type": "command",
  "name": "Example commands",
  "scope": "project:example",
  "priority": 100,
  "content": {
    "state": "known",
    "value": {
      "test": "npm test"
    }
  },
  "aliases": ["example commands"],
  "links": [{ "relationship": "documents", "to_id": "project:example" }],
  "sources": [{
    "origin": "package.json",
    "freshness": "current",
    "metadata": { "inspection": "inspected" }
  }]
}
```

Original records whose fields appear directly beside `content.state` remain
valid and normalize into returned `data` without rewriting stored content.
A put is a complete snapshot: replacing a record replaces owned aliases,
outgoing links, and sources while retaining its creation timestamp and incoming
links.

## Returned record

All public reads normalize records to:

```json
{
  "v": 1,
  "id": "project:example:commands",
  "kind": "command",
  "scope": "project:example",
  "availability": "known",
  "priority": 100,
  "revision": 12,
  "updated_at": "2026-08-13T12:00:00.000Z",
  "data": { "test": "npm test" },
  "links": [],
  "sources": []
}
```

## Identity and state

IDs and aliases are nonempty, NFC-normalized, case-sensitive UTF-8 strings.
Resolution checks an exact ID before an exact alias. Links are directed and
require both endpoint records to exist before commit.

`content.state` is one of `known`, `known_empty`, `unavailable`, `unknown`,
or `stale`. A missing record is not a knowledge-state claim. Source freshness
is independently `current`, `stale`, or `unknown`; source inspection is
`inspected`, `not_inspected`, `inspected_no_value`, or `unknown`.

## Agent-state kinds

- `project` records provide canonical roots for longest-prefix identity
  resolution.
- `work` records store actor-scoped advisory open and closed reports.
- `decision-event` records form an append-only per-project history; current and
  dead values are derived from those events.
- `handoff-lane`, `handoff-packet`, `handoff-tail`, `handoff-recovery`, and
  `handoff-state` records store session-isolated continuity, validated packet
  lineage, bounded redacted tails, and atomic startup claims.
- `migration-source` records bind imported source identity and checksum to the
  records created by the one idempotent migration path.

Kind-specific fields remain inside record `data`. Work, decision, and continuity operations
use the same revision allocator and record transaction core as `put`.

## Bounds

| Resource | Limit |
| --- | ---: |
| Startup envelope | 16 KiB |
| Handoff head within startup | 4 KiB |
| Put JSON input | 1 MiB |
| One CLI argument / all arguments | 16 KiB / 64 KiB |
| JSON nesting / structural nodes | 128 levels / 100,000 nodes |
| Canonical record content | 256 KiB |
| Source metadata | 64 KiB per source |
| Aliases / outgoing links / sources | 64 / 256 / 32 per record |
| Records | 100,000 per registry |
| Find results | 20 default, 100 maximum |
| Link results | 100 default, 500 maximum |
| Export | 64 MiB |

SQLite constraints independently enforce stored byte limits, JSON envelopes,
and UTC timestamps. Application validation adds normalization, collection,
and semantic checks.

## Migration

- Schema v1 migrates directly to v3 after an exclusive backup.
- Schema v2 migrates to v3 only when all retired continuity tables are empty.
  Any nonempty table produces `migration_state_conflict` and leaves the
  database unchanged.
- Unknown schema versions fail closed.
- The v0.7 generation-store importer remains one-way and never mutates its
  source.
- A version-1 migration manifest may also import work SQLite, decision JSONL,
  continuity JSON, and another current Lodestar SQLite source. It backs up the
  destination, fingerprints every source, verifies imports, and records source
  identity so a repeat does not duplicate state.
