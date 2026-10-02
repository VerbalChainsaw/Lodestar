# Lodestar

**Give your next session a head start.**

![A mountain trail at dawn beneath a guiding star](https://raw.githubusercontent.com/VerbalChainsaw/Lodestar/main/docs/assets/lodestar-ridgeline.png)

[Website](https://verbalchainsaw.github.io/Lodestar/) · [Install](docs/installation.md) · [Operator recipes](docs/operator-recipes.md) · [Release notes](docs/releases/v3.0.0.md) · [FAQ](Q&A.md)

Lodestar keeps project context, decisions, evidence, and unfinished work in one
local registry. Open **Loader** to see what needs attention, capture a useful
finding, review a correction, or recover an interrupted save. **Manager** brings
the same operations to a terminal menu. Your coding agent uses the same records
through the one-shot CLI or native integration.

Use it when new sessions keep rediscovering project facts, revisiting settled
decisions, or losing the thread of unfinished work. It provides a current starting
point and a checked correction path. You and your native project instructions
keep authority over the work.

## New in 3.0

Lodestar 3.0 adds two ways to work with the same local records. **Loader** is a
separate graphite Windows console for finding projects and records, inspecting
source and history, reviewing corrections, and saving deliberately. Its Health
view shows observed state and offers an explicit doctor check. **Manager** is a
compatible menu interface for the same core operations. Typed discovery, readable
record details, diagnostics, and bounded library continuation help with larger
stores and interrupted work. The Windows package supplies per-user installation,
portable configuration, launchers, and staged updates with recovery.

**Attention** brings unfinished work, pending items, acceptance gaps and missing
context into one project view. **Capture / link** saves knowledge, research or a
result, then reviews its association with the mission or a stable requirement.
The confirmed record stays available if linking is canceled or rejected.
Bounded relevant context brings useful evidence and active dependencies into a
continuation while naming omitted content and the full reads still needed.
See [operator recipes](docs/operator-recipes.md) for these journeys and
[intent and evidence](docs/intent-evidence.md) for interpreting recorded outcomes.

The core remains a one-shot CLI with contract 5 and schema 5. Existing schema-5
stores need no conversion; schema 4 requires an explicit verified upgrade. Product
version alone does not establish a store's schema. See the
[3.0 release notes](docs/releases/v3.0.0.md) and
[Windows setup instructions](docs/installation.md#windows-loader-and-manager-per-user-installation).

## One local authority

Loader, Manager, CLI and native tools share the same guarded record operations
and Windows-owned SQLite database. Reads inspect saved context and current source
evidence; writes require the observed basis, preserve history and issue receipts.

| Everyday problem | What Lodestar does |
| --- | --- |
| A new session starts from scratch. | Returns relevant saved context, decisions, and work for the current project and checkout. |
| A saved claim outlives its source. | Checks local file and package evidence during ordinary reads and flags claims needing reinspection. |
| An agent guesses how to update a record. | Exposes complete mutation inputs through JSON help and native describe, with a usable write basis from reads. |
| Two updates collide, or a response is lost. | Checks observed revisions, preserves history, and makes exact request retries safe for database effects. |
| Native skill copies drift. | Plans owned updates, preserves displaced bytes, verifies installed files, and reports local conflicts. |
| Project identity changes. | Keeps explicitly mapped member records usable while retaining their origin and history. |
| An agent re-proposes something already settled. | The rejection register surfaces settled subjects in orientation and search, with an advisory at write time — never a refusal. |

The [2.2.1 release notes](docs/releases/v2.2.1.md) describe the retained rejection
advisories and bounded reads. The [2.1.4 release notes](docs/releases/v2.1.4.md)
cover upgrading a separately cached Codex plugin to the complete package layout.

There is no daemon, telemetry, background indexer, or startup write. Missing optional
context does not stop work whose required inputs are otherwise available. A source
check is evidence at read time; it does not prove the truth of a saved claim.

## Install

The Windows package requires **Node.js 24.15.0 or newer**, **.NET 10
Desktop Runtime (x64)** and **PowerShell 7**. Download `Lodestar-3.0.0-win-x64.zip`
from the [3.0.0 release](https://github.com/VerbalChainsaw/Lodestar/releases/tag/v3.0.0),
verify its SHA-256 checksum, and extract the complete archive. Run `Install.cmd`,
then open Loader or Manager from the Start Menu.
`Install.ps1 -Mode Plan` shows the selection before installation.
`Setup.cmd` configures portable use. See [installation](docs/installation.md) for
runtime selection, upgrades and recovery.

The CLI alone requires **Node.js 24.15.0 or newer**. For a new installation:

```text
npm install --global lodestar-agent-context@3.0.0
lodestar setup --target all
lodestar setup --target all --apply
lodestar init
lodestar start --cwd .
```

Inspect the setup plan before applying it. Choose an individual target if you only
use one host. Independently edited skill files are reported for review; they are
not silently overwritten. Start fresh host sessions after installing updated skills.

**Upgrading an existing registry:** follow [storage and recovery](#storage-and-recovery)
before converting an older store. The current runtime uses schema 5. Schema-4
conversion is explicit and requires inspected preservation evidence and a backup.

Native skill targets are Codex, Claude Code, OpenCode, and Hermes. Other agents and
scripts can use the CLI. The optional Codex plugin exposes structured MCP tools.
Windows and WSL use the same Windows-owned database through the one-shot launcher.
Host discovery, authentication, and actual model use remain separate from package
compatibility; see [installation checks](docs/installation.md) and
[limitations](docs/limitations.md).

## Normal use

```text
lodestar start --cwd .
lodestar get project:example:commands
lodestar find "release process" --scope project:example
lodestar links project:example:commands
```

For project triage, read Attention; for recorded requirements and evidence, check
the selected intent. Replace the example ID with one from the project:

```text
lodestar work attention --cwd .
lodestar work check --cwd . -- knowledge:example-intent
lodestar work prepare-capture --help
lodestar put --help
```

Loader's Commands search and Manager's action finder use the same typed reference.
Native agents can call `lodestar_describe` for the installed operation declarations.
Follow the literal full-read arguments when a projection reports missing context.

Before a write, read the target and inspect its current basis. Use the installed
help for the operation's complete request and input schema, then preserve the
reviewed request in a UTF-8 file:

```text
lodestar put --file request.json
```

Reads supply the database instance, recovery epoch and target revisions for a
checked save. Repeating the exact request replays its receipt without another
database effect. Reusing a request ID with changed input fails; a stale basis
requires a fresh read and deliberate review.
Loader and Manager preserve uncertain saves for recovery. A confirmed record
stays available if its separate capture/link association fails. See
[operator recipes](docs/operator-recipes.md) for guided capture and uncertain-save
recovery. `delete` retires a record while preserving content and history.

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
| `recovery` | Inspect retained save journals or replay an exact guarded request deliberately. |
| `manager` | Open the terminal menu against the selected project and store. |

Ordinary `get`, `find`, and linked-peer reads compare local source evidence without
rewriting the saved observation. Inspect claims marked `needs_reinspection` before
depending on them. Invalid required dependencies identify incomplete context.

JSON help and native `lodestar_describe` include complete operation input schemas.
Run `lodestar --help` or `lodestar <command> --help` for the declarations used by
the CLI and native adapter. JSON is the default. Success goes to stdout and failure
to stderr using the same contract-5 envelope.

## Native integration

The optional [Codex plugin bundle](.codex-plugin/plugin.json) provides the automatic
Lodestar skill and three MCP tools:

- `lodestar_describe` returns the maintained operating guide and installed command
  and mutation declarations.
- `lodestar_read` invokes a declared read through the installed one-shot package.
- `lodestar_mutate` accepts the same short request and operation-specific input
  schema used by the CLI.

The **package root is the plugin root**. Codex caches that complete directory so
the adapter and shared core remain together. Do not install `codex-plugin/` alone;
that was the broken layout in 2.1.3 and earlier. Follow the
[optional plugin installation](docs/installation.md#optional-codex-plugin) steps.

The adapter does not maintain hooks, a session cache, a receipt store, or its own
authority rules. It passes actor identity only when an actual host invocation can
supply it; ordinary MCP transport cannot manufacture an authenticated user or
session. Windows and WSL callers still cross the Windows-owned one-shot shim and
never open SQLite from WSL.

## Skills and package integrity

The package retains six complete skills: `director-protocol`, `codeplan`,
`center-audit`, `ladder-audit`, `lodestar`, and `adderall`.
[`managed-assets/manifest.json`](managed-assets/manifest.json) names each maintained
source, entrypoint, distribution owner, source identity, and every payload file's raw
byte length and SHA-256. It is tied directly to contract 5; there is no second
manifest protocol. Private Golden Rules content is not bundled.

`center-multigeometry` is distributed independently by the canonical `center-geo`
skill bundle. Lodestar does not install, verify, or receipt that external skill.

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
if ($LASTEXITCODE -ne 0) { throw "Source preflight failed; do not migrate." }
lodestar migration-backup --db $db $backup
if ($LASTEXITCODE -ne 0) { throw "Restore-tested backup failed; preserve any reported destination and do not migrate." }
lodestar doctor --migration-preflight --db $backup | Set-Content .\backup-preflight.json -Encoding utf8NoBOM
if ($LASTEXITCODE -ne 0) { throw "Backup preflight failed; do not migrate." }
node -e "const f=require('fs'),c=require('crypto'),p=JSON.parse(f.readFileSync('preflight.json')).data,b=JSON.parse(f.readFileSync('backup-preflight.json')).data;if(p.logical_digest!==b.logical_digest||p.schema_fingerprint!==b.schema_fingerprint)throw Error('Backup does not match source preflight');f.writeFileSync('migration-request.json',JSON.stringify({v:5,request_id:c.randomUUID(),preflight:p,backup:{path:b.source.path,logical_digest:b.logical_digest,schema_fingerprint:b.schema_fingerprint}},null,2),{flag:'wx',flush:true})"
if ($LASTEXITCODE -ne 0) { throw "Matching migration request was not created; do not migrate." }
lodestar init --migrate --db $db --file .\migration-request.json
lodestar doctor --db $db
```

The SQLite backup API includes committed WAL state; copying only the main database
file is insufficient while a WAL file exists. Migration rechecks the locked source against `preflight` and requires the
restore-inspected backup digest to match. Keep the backup and request until the
converted database and required reads have been verified.

Request creation reserves `migration-request.json` exclusively and flushes its
bytes before dispatch. If it already exists, preserve it and reconcile that exact
request and receipt; do not overwrite it by rerunning the creation step. An
interrupted write may leave an unaccepted partial file, which must be inspected
before selecting a fresh request path.

The helper and recipe stage a completed SQLite backup beside the destination, then
reserve a fresh destination exclusively and copy through its open file handle using
a 64 KiB buffer. Existing destinations, source aliases and competing creators cause
refusal. Copy completion requires successful flushing and restore inspection; the
helper compares the destination's schema and logical digest to its staged snapshot.
The recipe then runs migration preflight on the completed backup. Hard links are
not required. Failure or interruption can leave an incomplete, unaccepted new
destination and a `.lodestar-backup-*` staging directory. Preserve those files for
inspection, select a fresh path for another attempt, and use a backup only after
successful completion and matching migration evidence. Cleanup never deletes the
requested destination.

Storage errors name the database and its storage directory. `database_storage_full`
can mean insufficient free space or SQLite's page limit. Preserve the database,
journals and exact request, resolve capacity, then reconcile the original request
before retrying. `database_recovery_required` means SQLite needs recovery writes
before ordinary read-only inspection can continue. Pause writers and preserve the
database and adjacent journals together; arrange explicit SQLite recovery on
writable local storage. Keep unknown writes unknown until their original request
has been reconciled. Do not delete journals or reset the database to enable a read.

Writers use DELETE journals and synchronous FULL. For Node 24.15.0's Windows SQLite
VFS, the journal-delete method ignores the directory-sync flag that EXTRA adds;
changing FULL to EXTRA supplies no additional directory flush through that VFS.
The configuration remains DELETE/FULL. Recovery of an interrupted process is
verified on disposable stores; retention of the final acknowledged commit after
power loss depends on the filesystem, device and flush behavior and is not proved
by that test. See the [SQLite synchronous contract](https://sqlite.org/pragma.html#pragma_synchronous)
and [Node 24.15.0's SQLite Windows VFS](https://github.com/nodejs/node/blob/v24.15.0/deps/sqlite/sqlite3.c#L53633).

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

`assets:build` requires the explicit Golden source root before it updates the four
Golden-owned generated package copies. `assets:check` verifies the packaged raw-byte
manifest without needing a machine-specific source path; add the same `--source-root`
argument when source-to-package verification is required.

## License

MIT. See [LICENSE](LICENSE).
