# Lodestar integrity and maintenance

Lodestar remains a local, zero-dependency, no-daemon system. Maintenance is an
explicit, scheduler-friendly command rather than a resident service. The
default path is read-only.

## Integrity layers

New generations contain `integrity.json`, a deterministic SHA-256 manifest for
the catalog, schema, record shards, and every generated index. The generation
identifier independently hashes canonical source data.

```sh
agentctx doctor
agentctx doctor --deep
```

Ordinary doctor validates structure, graph integrity, index generations,
scopes, locators, readiness, locks, atomic rename behavior, and filesystem
durability. Deep doctor additionally:

- checks every sealed file checksum;
- recomputes the generation identifier from canonical source data;
- rebuilds deterministic indexes in memory and compares their content;
- reports sealed and legacy-unsealed generation counts.

Legacy generations without a manifest remain readable. Deep doctor still
recomputes their source identity and index content. Every newly written
generation is sealed.

Writes synchronize staged files before generation promotion. Directory
synchronization is used when supported. `doctor` reports the effective
filesystem durability level; local NTFS, APFS, and ext4 state homes are
preferred over network shares.

## Resource limits

Lodestar rejects records, catalogs, graphs, shards, or transactions that exceed
versioned limits before index construction or persistence. Limits cover:

- record and store bytes;
- project and record counts;
- nested depth and node count;
- string, array, and object sizes;
- links, locators, scopes, roots, and aliases.

Failures use `resource-limit-exceeded` with the measured resource, actual
value, and maximum. The limits protect the deterministic local store from
accidental or hostile memory, disk, and index amplification.

## Verified snapshots and restore

Create a portable snapshot outside the state home:

```sh
agentctx snapshot --home /path/to/.lodestar --to /backups/lodestar-2026-07-30
agentctx snapshot --verify /backups/lodestar-2026-07-30
```

The snapshot captures one immutable active generation, its pointer, and the
audit prefix. It has its own file-set and checksum manifest and is deeply
verified before publication.

Restore always targets a path that does not exist:

```sh
agentctx restore \
  --from /backups/lodestar-2026-07-30 \
  --home /path/to/restored-lodestar \
  --dry-run

agentctx restore \
  --from /backups/lodestar-2026-07-30 \
  --home /path/to/restored-lodestar

agentctx doctor --home /path/to/restored-lodestar --deep
```

Lodestar deliberately refuses in-place restore. Validate the restored home,
then change `LODESTAR_HOME` or move it during a controlled outage. Existing
state is never overwritten by the restore command.

Snapshots reject symlinks, path overlap, unknown file types, excess file
counts, excess bytes, extra files, missing files, changed bytes, and generation
identity mismatches.

## Maintenance and retention

Preview maintenance:

```sh
agentctx maintain --home /path/to/.lodestar
```

The JSON report contains:

- active generation and total generation storage;
- generation count and proposed retention set;
- audit size and rotation decision;
- current, drifted, unverified, blocked, and failed project fingerprints;
- exact generations that would move to quarantine.

Apply a bounded policy:

```sh
agentctx maintain \
  --home /path/to/.lodestar \
  --retain 10 \
  --apply
```

Maintenance deeply validates the store before mutation. Excess generations are
atomically moved to `quarantine/generations`; the active generation is always
retained. A failed multi-generation move restores every generation already
moved or reports an explicit rollback failure.

Quarantined generations are not deleted automatically, and v0.6 exposes no
purge command. This keeps retention recoverable while deletion policy,
authorization, partial-failure behavior, and independent backup proof remain
future work.

Recover one generation without activating it:

```sh
agentctx recover <generation-id> --home /path/to/.lodestar
```

Recovery moves exactly one matching quarantine entry back only after deep
integrity and semantic validation. Add `--promote` to make it active; pointer,
audit, and quarantine rollback remain one writer-locked transaction.

The audit log rotates only after it exceeds `--audit-max-bytes` (default
4 MiB). Rotation validates every JSONL event and starts a new log with the
prior filename, event count, byte count, and SHA-256 checkpoint.

Use `--skip-drift` when only storage administration is required. Maintenance
never modifies curated records and does not automatically refresh drifted
projects.

## Source drift

Project profiling already stores a bounded SHA-256 fingerprint derived from
recognized manifests, shallow filenames, environment locators, entrypoints,
top-level directories, stack metadata, and discovered commands.

`maintain` recomputes that same bounded fingerprint without reading source
files, `.env` values, or unrecognized document bodies. A changed fingerprint
is reported as `drifted`. Refresh intentionally:

```sh
agentctx refresh --project p:example --dry-run
agentctx refresh --project p:example
agentctx coverage --project p:example --require-ready
```

## Store-schema evolution

The current store schema remains version 1. v0.6 intentionally exposes no
`migrate-store` command because there is no real schema transition to perform.
A future public migration command must ship with an ordered transformation,
pre-migration verified snapshot, full validation, rollback proof, and fixtures
for both old and new stores.

## Scheduling

An unattended job should normally run read-only checks:

```sh
agentctx doctor --deep
agentctx maintain
agentctx coverage --require-ready
```

Schedule `maintain --apply` only with an explicit, reviewed retention policy.
Snapshot independently to another disk before any manual quarantine cleanup.
No Lodestar operation requires a watcher, daemon, cloud account, or network
service.
