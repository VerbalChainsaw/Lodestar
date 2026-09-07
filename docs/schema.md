# Lodestar schema and contract 5

Schema 5 stores all durable state in five strict, without-rowid tables:

```text
metadata(key, value)
records(id, type, name, scope, content_json, created_at, updated_at)
links(from_id, relationship, to_id, created_at)
aliases(alias, record_id)
sources(record_id, origin, freshness, metadata_json)
```

The exact DDL and writer triggers live in `src/schema.mjs`. Metadata contains
`schema_version`, `database_instance_id`, `database_epoch`, `database_revision`, and
`created_at`.

## Read model

Current normalized records expose stable ID, kind, scope, availability, priority,
accepted revision, timestamps, application data, aliases, links, sources, and
semantics. Application-owned JSON remains application-owned. Raw inspection and
history preserve exact stored JSON text and associations. JSON numeric tokens outside
JavaScript's safe integer domain fail normalized processing before rounding.

Semantics identify basis (`asserted`, `observed`, `user_direction`, or
`legacy_unverified`), lifecycle, context role, and project/checkout applicability. Local and
package evidence uses a locator plus SHA-256 byte fingerprint. Runtime/external
observations use an observation time and evidence reference. User direction never
requires a fabricated file fingerprint.

## Mutation contract

Every ordinary write supplies contract 5, a unique request ID, database instance and
epoch, project scope and checkout applicability, explicit target preconditions, and a
validated operation input. Target kinds are `record` or `decision`. An absent target
uses an absence precondition; an existing target uses its accepted revision.

The core checks instance and epoch before receipt replay, hashes the entire request,
replays an identical receipt, rejects changed reuse, verifies target and binding heads,
allocates one database revision, preserves raw before-images, applies the domain
mutation, and commits its receipt in one admitted immediate transaction. Nested domain
helpers reuse that revision. Lock contention fails immediately as retryable busy.

Schema triggers call the connection-scoped `lodestar_write_contract()` guard on every
state-table insert, update, and delete. A retained old connection or prepared statement
cannot write after schema-5 activation.

## Ordering and history

Database and subject revisions order accepted state. Wall-clock timestamps describe
observation or commit time and never decide the current head. Retirement removes a
record from current orientation without physical deletion. Exact content, inbound and
outbound associations, and receipt-backed history remain retrievable.

## Lifecycle conversion and recovery

Runtime contains one explicit schema-4 to schema-5 conversion. Ordinary operations do
not migrate. Preflight identifies the exact source metadata, schema fingerprint,
logical row digest, unsafe numeric rows, and deterministic accounting. A consistent
backup is restore-inspected before a locked source recheck and atomic conversion.

`doctor --migration-preflight` returns the source observation inside the normal
contract-5 envelope. The migration request contains `{v,request_id,preflight,backup}`;
`backup` carries the restore-inspected backup path, logical digest, and schema
fingerprint. `init --migrate --file <request.json>` is the only conversion command.

For current content owners, write preparation reopens the declared local/package
source and requires the exact fingerprint and byte count. A `source_root` locator
includes `source_id`; its source-configuration record revision must be present in the
write basis, so the root cannot be silently rebound between inspection and admission.

No schema-1, schema-2, or schema-3 production parser or converter ships. After an
accepted schema-5 write, rollback to schema 4 is unsupported. A fully accounted
schema-5 recovery image is promoted explicitly: its database instance remains stable,
a new epoch is allocated, and old request bases fail before receipt replay.
