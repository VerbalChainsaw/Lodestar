# Lodestar

Lodestar is a local, JSON-first project context registry for agents. Version 2.1
ships one executable, one contract-5 envelope, one current SQLite schema, and one
guarded mutation path for facts, decisions, work outcomes, and continuity.

```text
npm install --global .\lodestar-agent-context-2.1.0.tgz
lodestar setup --target all
lodestar setup --target all --apply
lodestar init
lodestar start --cwd .
```

The local tarball is the supplied release artifact. Use the registry package name
only after version 2.1.0 has been published. Review the setup plan; existing locally
changed or unowned skills require `--replace-local`, which preserves backups.
Choose an individual `--target` to install only one host. See
[installation and startup checks](docs/installation.md). `init` is explicit and idempotent for a
new current store; `start` never creates one.

`start` resolves the current project and checkout, reads applicable configured
sources, and returns relevant records, conflicts, source status, and a usable
`write_basis`. It also returns the maintained operating guide and a fresh, read-only
installation check with an actionable setup command when needed. It does not
initialize or mutate a database. Missing optional
Lodestar context does not prevent ordinary work from native files and tools.

## Normal use

```text
lodestar start --cwd .
lodestar get project:example:commands
lodestar find "release process" --scope project:example
lodestar links project:example:commands
```

Reads return the database instance, recovery epoch, accepted revision, and target
revisions needed for a safe update. A short mutation request has one shape:

```json
{
  "v": 5,
  "request_id": "018f-example-unique-request",
  "write_basis": {
    "database_instance_id": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "database_epoch": "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    "project_scope": "project:example",
    "checkout": null,
    "targets": [
      { "kind": "record", "id": "project:example", "expected_revision": 4 },
      { "kind": "record", "id": "project:example:commands", "expected_revision": null }
    ]
  },
  "input": {
    "mode": "create",
    "record": {
      "id": "project:example:commands",
      "kind": "command",
      "name": "Example commands",
      "scope": "project:example",
      "availability": "known",
      "data": { "test": "npm test" },
      "aliases": [],
      "links": [],
      "sources": [],
      "semantics": {
        "basis": "asserted",
        "lifecycle": "current",
        "context_role": "orientation",
        "applicability": { "project": "project:example", "checkout": null }
      }
    }
  }
}
```

```text
lodestar put --file request.json
```

Repeating the exact request replays its receipt without another effect. Reusing a
request ID with changed input fails. A stale target, project binding, database
instance, or recovery epoch changes nothing and returns a usable refreshed basis.
`delete` retires a record from current orientation while preserving its content,
associations, and history.

## Commands

| Command | Purpose |
| --- | --- |
| `start` | Read fresh project orientation without writing. |
| `get`, `find`, `links` | Retrieve current, raw, historical, or related records. |
| `put`, `delete` | Apply a checked record update or retirement. |
| `work` | Read work state or record actual progress and outcomes. |
| `decision` | Read and update reasoned decision streams. |
| `handoff` | Preserve and explicitly claim continuity without creating sessions. |
| `pending` | Keep unresolved candidates outside orientation until promotion. |
| `doctor`, `export` | Inspect integrity, produce conversion/recovery preflight evidence, or export exact private recovery evidence. |
| `skills`, `agents` | Verify skill copies or inspect/print agent templates read-only. |
| `init` | Explicitly create, migrate, or promote a recovered store. |
| `setup` | Plan or explicitly install native skills, preserving replaced content and recovering interrupted installs. |

Run `lodestar --help` or `lodestar <command> --help` for the declarations used by
the CLI and native adapter. JSON is the default. Success goes to stdout and failure
to stderr using the same contract-5 envelope.

## Native integration

The optional [Codex plugin bundle](codex-plugin/.codex-plugin/plugin.json) provides the automatic
Lodestar skill and three MCP tools:

- `lodestar_describe` returns the maintained operating guide and installed command
  and mutation declarations.
- `lodestar_read` invokes a declared read through the installed one-shot package.
- `lodestar_mutate` accepts the same short request and operation-specific input
  schema used by the CLI.

The adapter does not maintain hooks, a session cache, a receipt store, or its own
authority rules. It passes actor identity only when an actual host invocation can
supply it; ordinary MCP transport cannot manufacture an authenticated user or
session. Windows and WSL callers still cross the Windows-owned one-shot shim and
never open SQLite from WSL.

## Skills and package integrity

The package retains seven complete skills: `director-protocol`, `codeplan`,
`center-multigeometry`, `center-audit`, `ladder-audit`, `lodestar`, and `adderall`.
[`managed-assets/manifest.json`](managed-assets/manifest.json) names each maintained
source, entrypoint, distribution owner, source identity, and every payload file's raw
byte length and SHA-256. It is tied directly to contract 5; there is no second
manifest protocol. Private Golden Rules content is not bundled.

`lodestar skills verify` is read-only. `lodestar setup` plans native installation;
`--apply` performs it. Both share the package manifest and host discovery resolver.
Verification checks known user skill roots, deduplicates physical aliases, and
reports divergent copies. Exact mirrored copies are identified without treating
them as content conflicts. Custom project/plugin roots, permissions, and actual
model selection require native host checks; file verification does not certify them.

## Storage and recovery

Current runtime supports schema 5 only. Ordinary reads and writes refuse absent or
older stores without creating or converting them. The lifecycle owner can preflight,
back up, and explicitly convert the inspected schema-4 store. After current-contract
writes, recovery proceeds forward. Promoting a fully accounted recovered schema-5
image retains its database instance ID and allocates a new epoch so every old basis
fails before replay or mutation.

For an existing schema-4 store, pause every writer and use a distinct backup path:

```powershell
$db = "$env:LOCALAPPDATA\Lodestar\lodestar.db"
$backup = ".\lodestar-schema4.backup.db"
lodestar doctor --migration-preflight --db $db | Set-Content .\preflight.json -Encoding utf8NoBOM
node -e "const {DatabaseSync,backup}=require('node:sqlite');const source=new DatabaseSync(process.argv[1],{readOnly:true});backup(source,process.argv[2]).finally(()=>source.close())" $db $backup
if ($LASTEXITCODE -ne 0) { throw "SQLite backup failed; do not migrate." }
lodestar doctor --migration-preflight --db $backup | Set-Content .\backup-preflight.json -Encoding utf8NoBOM
node -e "const f=require('fs'),c=require('crypto'),p=JSON.parse(f.readFileSync('preflight.json')).data,b=JSON.parse(f.readFileSync('backup-preflight.json')).data;f.writeFileSync('migration-request.json',JSON.stringify({v:5,request_id:c.randomUUID(),preflight:p,backup:{path:b.source.path,logical_digest:b.logical_digest,schema_fingerprint:b.schema_fingerprint}},null,2))"
lodestar init --migrate --db $db --file .\migration-request.json
lodestar doctor --db $db
```

The SQLite backup API includes committed WAL state; copying only the main database
file is insufficient while a WAL file exists. Migration rechecks the locked source against `preflight` and requires the
restore-inspected backup digest to match. Keep the backup and request until the
converted database and required reads have been verified.

A `content_owner` source using `local_file` or `package_manifest` must still match
its exact locator, byte count, and SHA-256 immediately before write admission. If it
changed, inspect it again and prepare a new logical request. A locator based on
`source_root` also names `source_id`; its `config:lodestar:sources` record revision is
a required mutation precondition, so changing the root configuration invalidates the
old basis.

See [schema](docs/schema.md), [limitations](docs/limitations.md), and the
[2.0.0 release notes](docs/releases/v2.0.0.md).

## Development

Requires Node.js 24.15.0 or newer and no third-party runtime dependencies.

```text
npm test
npm run pack:check
npm run assets:build -- --source-root <Golden-Rules-root>
```

`assets:build` requires the explicit Golden source root before it updates the five
Golden-owned generated package copies. `assets:check` verifies the packaged raw-byte
manifest without needing a machine-specific source path; add the same `--source-root`
argument when source-to-package verification is required.

## License

MIT. See [LICENSE](LICENSE).
