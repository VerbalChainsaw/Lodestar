# Lodestar schema version 1

One SQLite database is the source of truth. Schema version 1 has four core
tables and one metadata table:

```text
metadata(key, value)
records(id, type, name, scope, content_json, created_at, updated_at)
links(from_id, relationship, to_id, created_at)
aliases(alias, record_id)
sources(record_id, origin, freshness, metadata_json)
```

The exact DDL is defined in `src/schema.mjs`. Tables are `STRICT` and
`WITHOUT ROWID`. Foreign keys cascade dependent aliases, sources, and incoming
or outgoing links when a record is deleted.

## Put input

`lodestar put` accepts exactly one JSON object:

```json
{
  "id": "project:example:commands",
  "type": "command",
  "name": "Example commands",
  "scope": "project:example",
  "content": {
    "state": "known",
    "value": {
      "test": "npm test"
    },
    "reason": "Optional evidence or limitation"
  },
  "aliases": [
    "example commands"
  ],
  "links": [
    {
      "relationship": "documents",
      "to_id": "project:example"
    }
  ],
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

The `aliases`, `links`, and `sources` arrays are optional and default to empty.
A put is a complete snapshot: replacing a record replaces its owned aliases,
outgoing links, and sources while retaining its creation timestamp and any
incoming links.

Unknown fields are rejected. JSON values must be finite, serializable JSON;
object keys are emitted in canonical order. File and stdin input must be valid
UTF-8; malformed bytes, unpaired Unicode surrogates in IDs and schema text
fields, sparse arrays, excessive nesting, and excessive structural node counts
are rejected rather than silently rewritten.

## Identity

IDs and aliases are nonempty, NFC-normalized, case-sensitive UTF-8 strings.
Resolution checks an exact record ID before an exact alias. Aliases are
globally unique and cannot equal any record ID.

Links are directed and require both records to exist before commit. A link is
identified by `(from_id, relationship, to_id)`.

## Knowledge states

`content.state` is required:

| State | Meaning |
| --- | --- |
| `known` | The record asserts a value. |
| `known_empty` | Inspection supports an explicitly empty value. |
| `unavailable` | The intended source could not be accessed. |
| `unknown` | No supported assertion is available. |
| `stale` | A prior value is retained but may be out of date. |

A record that does not exist has none of these states. It is missing knowledge,
not a claim that no underlying value exists.

Source freshness is independently one of `current`, `stale`, or `unknown`.
Every source metadata object requires an `inspection` value:

| Inspection | Meaning |
| --- | --- |
| `inspected` | The named source was inspected. |
| `not_inspected` | Direct evidence says it was not inspected. |
| `inspected_no_value` | It was inspected and no applicable value was found. |
| `unknown` | Lodestar lacks inspection evidence. |

Additional source metadata is caller-defined JSON. Lodestar stores it but does
not verify its truth.

## Bounds

| Resource | Limit |
| --- | ---: |
| Put JSON input | 1 MiB |
| One CLI argument / all arguments | 16 KiB / 64 KiB |
| Database or input path | 16 KiB |
| JSON nesting / structural nodes | 128 levels / 100,000 nodes |
| Canonical record content | 256 KiB |
| Source metadata | 64 KiB per source |
| Aliases | 64 per record |
| Outgoing links | 256 per record |
| Sources | 32 per record |
| ID or alias | 256 UTF-8 bytes |
| Type or relationship | 64 UTF-8 bytes |
| Name | 256 UTF-8 bytes |
| Scope | 512 UTF-8 bytes |
| Source origin | 4,096 UTF-8 bytes |
| Records | 100,000 per registry |
| Find results | 20 default, 100 maximum |
| Link results | 100 default, 500 maximum |
| Export | 64 MiB |
| Encoded command output | 80 MiB |
| Legacy import | 100,000 items and 128 MiB of accepted source files |

Limit failures use `resource_limit` and report the measured and maximum values.
SQLite `CHECK` constraints independently enforce stored UTF-8 byte limits,
JSON envelopes, and exact UTC timestamp shape; application validation adds NFC,
control-character, collection-count, and semantic checks.

## Transactions and timestamps

Put, delete, schema initialization, and legacy import use one SQLite
transaction apiece. Timestamps are RFC 3339 UTC with millisecond precision.
Lodestar preserves `created_at` when replacing a record and changes
`updated_at` only after a successful write.

Schema metadata initially contains only:

```json
{
  "schema_version": "1",
  "created_at": "<RFC3339 UTC timestamp>"
}
```

An unknown schema version is rejected. There is no automatic schema migration
framework in version 1.
