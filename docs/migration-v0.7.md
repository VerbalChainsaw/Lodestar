# Importing a Lodestar v0.7 store

The importer is a one-time, one-way bridge from a v0.7-compatible generation
store to an empty Lodestar SQLite database. It is not a second live storage
engine, merge tool, or dual-write compatibility mode.

## Before importing

Stop processes that can write the old store and keep an independent backup.
Choose a destination outside the old store tree.

Preview the complete conversion:

```text
lodestar import /path/to/v0.7-home \
  --dry-run \
  --db /path/to/new/lodestar.db
```

Dry-run builds and diagnoses an in-memory database. It does not create the
destination or change the source. It applies the same conversion and validation contract as a real import.

The source must contain:

```text
current.json
generations/<active-generation>/catalog.json
generations/<active-generation>/schema/store.json
generations/<active-generation>/records/global.jsonl
generations/<active-generation>/records/projects/<project>.jsonl
```

`indexes/locator-health.json` is optional. When present and valid, its direct
path-probe observations are retained only when uniquely attributable to a
source that survives conversion. Ambiguous, orphaned, or otherwise unretained
observations are reported exactly once as unsupported migration evidence.
Lodestar does not reinterpret an existence probe as proof that file contents
were inspected.

If `integrity.json` exists, its complete file set and SHA-256 digests must
verify. A missing manifest is reported as `unsealed`; a present invalid
manifest is fatal. The store layout records schema `v: 1`, so the importer
reports `version_evidence: "compatible_layout"` rather than inventing an exact
npm package version.

## Conversion

| v0.7 item | Lodestar schema version 4 |
| --- | --- |
| Catalog project | `type: "project"` record with the project payload retained as content |
| Global/project record | Record with its valid original ID, old kind as type, and old payload retained as content |
| One scope | Scalar scope |
| Multiple scopes | `global` when present, otherwise the sorted first scope; reported as a semantic collapse |
| `none_verified: true` | `content.state: "known_empty"` |
| Old aliases | Exact aliases when globally unambiguous |
| Old `links` | Directed `related` links |
| Old `routes` | Directed `route:<name>` links |
| Old `locators` | Source rows keyed by locator path |
| Locator-health index | Exact legacy `ok`, `missing`, `unreadable`, or `unchecked` observation in source metadata |
| Verification fields | Source inspection metadata |
| Invalid, missing, or duplicate ID | Deterministic `legacy:<hash>` from generation and source location, plus an `id_mappings` entry |

The importer preserves each accepted legacy payload under `content.value`.
It does not infer freshness, inspection, completeness, or readiness absent
direct evidence.

Conflicting aliases, missing link targets, structurally invalid values, and
unsupported semantics are reported under `skipped`, `unsupported`, or
`id_mappings` with their source location and disposition. Every valid legacy
field item and every migration disposition is processed and reported.

## Migration report

The JSON report includes:

- source path, active generation, integrity evidence, fingerprint, and
  unchanged status;
- destination path, schema version, and commit status;
- counts for imported records, aliases, links, and sources;
- complete skipped, unsupported, and identifier-mapping detail arrays;
- `reporting` totals confirming every detail entry was emitted;
- SQLite integrity, foreign-key, and doctor results.

Migration detail is complete: Lodestar does not clip report entries or omit valid
legacy items to satisfy an internal quota. Review the arrays even when `doctor_ok`
is true because database validity does not mean every old semantic was
representable. Do not discard the old store while any skipped or unsupported
migration evidence remains unresolved.

## Commit and validation

After reviewing dry-run, run the same command without `--dry-run`:

```text
lodestar import /path/to/v0.7-home --db /path/to/new/lodestar.db
```

The destination may be absent or an initialized, empty current-schema database. A missing destination is reserved without replacement; a concurrent
creator is never overwritten or deleted by losing-process cleanup. A visible
zero-byte reservation is safe to resume and remains after a definite creation
failure. An existing destination with more than one hard link is rejected
because it could alias a file in the source tree. A populated destination is
rejected. Schema creation and imported rows commit in one transaction. The
importer fingerprints accepted source files before and immediately before
commit, then reopens and diagnoses the destination read-only.

If `COMMIT` raises while SQLite still reports an active transaction, Lodestar
rolls it back and reports a definite database error. If SQLite has ended the
transaction without confirming the call, Lodestar reports
`import_commit_outcome_unknown` and preserves the destination. Keep both stores
and run `lodestar doctor`; deleting a possibly committed database would destroy
evidence.

Validate before discarding the old store:

1. Save the migration report.
2. Run `lodestar doctor`.
3. Compare record, alias, link, and source counts.
4. Retrieve representative original IDs and aliases.
5. Follow representative incoming and outgoing links.
6. Save and inspect `lodestar export`.
7. Keep or archive the old store until the new database meets your needs.

Lodestar never deletes, renames, locks, marks, or writes a report into the old
store. Removing it is a separate, explicit user action outside this tool.
