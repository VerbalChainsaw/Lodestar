# Lodestar

Lodestar is a local, deterministic linked-context store and project-discovery
tool for coding agents. It gives an agent one small startup packet and stable
links to exact commands, constraints, decisions, answers, and documentation
locations before broader repository inspection is necessary.

Lodestar does not upload state, ingest source trees, require a database, run a
daemon, or replace source control. Runtime state is stored outside the installed
package.

## Requirements and platform support

- Node.js 22 or newer, with npm
- Native Windows 10/11, WSL, Linux, or macOS
- PowerShell for `install.ps1`, or a POSIX shell for `install.sh`

The same package and store format are used on every supported platform.

## Quick start

Download `lodestar-agent-context-0.4.4.tgz` and `SHA256SUMS.txt` from the
[v0.4.4 release](https://github.com/VerbalChainsaw/Lodestar/releases/tag/v0.4.4),
verify the checksum, and install:

```sh
npm install --global ./lodestar-agent-context-0.4.4.tgz
agentctx init
agentctx doctor
agentctx start --cwd /path/to/project
```

To preview bounded project discovery and starter profiling during initialization:

```sh
agentctx init --discover --root /path/to/development --skip-codex
agentctx init --discover --root /path/to/development --yes --skip-codex
```

The first command creates the state home and returns a discovery preview. The
second confirms catalog insertion and generates bounded command, entrypoint,
environment, and rule records. Omit `--skip-codex` on the confirmed command to
install the managed Codex block.

From a source checkout, the guided installer initializes the state home and
installs Lodestar's managed Codex instruction block:

```powershell
# Native Windows PowerShell
.\install.ps1
```

```sh
# WSL, Linux, or macOS
./install.sh
```

Useful installer options:

```text
--package <checkout-or-tarball>
--prefix <npm-prefix>
--home <lodestar-state-home>
--legacy-home <legacy-flat-store>
--codex-home <codex-home>
--skip-codex
--dry-run
```

Run `node install.mjs --dry-run --skip-codex` to inspect an installation plan
without writing files or launching npm.

## Agent lookup protocol

The intended path is:

```text
agentctx start --cwd <cwd>
  > agentctx get <id> / agentctx resolve <id>
  > agentctx find <query> --cwd <cwd>
  > targeted repository inspection after a context miss
```

`start` returns required global and current-project records plus compact cards
for available linked records. `get` performs exact retrieval. `resolve` follows
stable record links with bounded breadth-first traversal. `find` searches only
indexed structured context in the authorized global/current-project scope; it
does not scan repository files.

All commands emit JSON. Failures emit a stable error code and details to stderr
and exit nonzero. A lookup that has no result reports `context-miss` and directs
the agent to a targeted repository inspection rather than silently widening
scope.

## Commands

| Command | Purpose |
| --- | --- |
| `agentctx init` | Create a valid state home from packaged templates. Add `--discover --root <path>` to preview starter curation and `--yes` to confirm it. |
| `agentctx start --cwd <path>` | Return the bounded startup packet for the current project. |
| `agentctx get <id>` | Return one exact, scope-authorized record. |
| `agentctx resolve <id> [--depth <1-3>]` | Return an exact record and its bounded linked graph. |
| `agentctx find <query> --cwd <path>` | Search structured fields in global/current-project scope. |
| `agentctx project [selector]` | Return the current project or a matching project card. |
| `agentctx put --json '<record>'` | Validate and transactionally write one curated record. Use `--file <path>` or stdin instead; generated records require `--take-ownership`. |
| `agentctx doctor` | Validate pointers, generations, graph, every index, scopes, roots, locators, locks, startup budgets, and write semantics. |
| `agentctx coverage [--project <id>]` | Report structured-context coverage. |
| `agentctx ask <intent> <project>` | Query a project context using a recognized intent. |
| `agentctx profile-projects [--project <id>]` | Refresh bounded generated project metadata without overwriting curated records. Add `--dry-run` for a non-mutating preview. |
| `agentctx refresh` | Profile projects; equivalent to `profile-projects`. Supports `--dry-run`. |
| `agentctx refresh --discover --root <path> --yes` | Discover and add projects under explicit roots after confirmation. |
| `agentctx migrate-legacy --from <path>` | Import a legacy flat Lodestar store without changing the source. |
| `agentctx migrate-projects --from <registry.json>` | Import an explicit project registry. |
| `agentctx inventory-codex --root <path>` | Inventory hashes and metadata under explicit roots; never file contents. |
| `agentctx install-codex [--codex-home <path>]` | Install or update only Lodestar's marked Codex instruction block. |
| `agentctx rollback [--manifest <path>] [--force]` | Restore managed Codex files from an installation manifest. |

Every command accepts `--home <path>`. Project-aware read commands also accept
`--cwd <path>` and `--project <id>`.

## Windows and WSL

Install Lodestar on each side where an agent runs. Native Windows and WSL can
share one canonical state store:

```powershell
# Windows PowerShell
.\install.ps1 --home C:\Users\name\.lodestar
```

```sh
# WSL
./install.sh --home /mnt/c/Users/name/.lodestar --skip-codex
export LODESTAR_HOME=/mnt/c/Users/name/.lodestar
```

Persist `LODESTAR_HOME` in the WSL shell profile if you do not want to pass
`--home` on each command. Windows paths supplied to a WSL process, such as
`C:\Users\name\project`, are translated to `/mnt/c/Users/name/project`.
Catalog roots and diagnostics are translated for the active runtime as well.

Use one writer at a time across Windows and WSL. Readers see only complete
immutable generations. The writer uses atomic directory locking, records its
PID and host, maintains a heartbeat, and automatically reclaims a dead
same-host lock after the stale grace period.

## State home and data layout

State-home precedence is:

```text
--home
> LODESTAR_HOME
> AGENT_CONTEXT_HOME
> <user home>/.lodestar
```

The home contains the project catalog, immutable store generations, current
generation pointer, deterministic route/search/locator-health indexes,
transaction staging, audit events, inventory, and managed-file backups. Package
code and user state are deliberately separate, so reinstalling the package does
not replace the store.

Records are JSON objects stored in JSONL shards. Each has a stable `id`, schema
version `v`, recognized `kind`, `priority`, explicit `scope`, and `links`.
Structured fields may include `summary`, `facts`, `commands`, `action`,
`aliases`, `topics`, and confined documentation `locators`.

Example curated record:

```json
{
  "v": 1,
  "id": "p:demo:commands",
  "kind": "command",
  "priority": 850,
  "scope": ["project:p:demo"],
  "links": ["p:demo:constraints"],
  "commands": {
    "test": "npm test",
    "dev": "npm run dev"
  }
}
```

Write it without bypassing validation, index rebuilding, audit history, or the
transaction boundary:

```sh
agentctx put --json '{"v":1,"id":"p:demo:commands","kind":"command","priority":850,"scope":["project:p:demo"],"links":[],"commands":{"test":"npm test"}}'
agentctx put --file ./commands-record.json
```

Generated records are refresh-owned and cannot be overwritten accidentally.
Use `--take-ownership` only when intentionally converting one to a curated
record. Every successful write records prior and next hashes in the local audit
log; an audit-write failure restores the previously active generation.

Direct editing of generated JSONL or index files is unsupported because it can
make the route and search indexes disagree with the records.

## Add, migrate, and refresh projects

Discover projects only under roots you explicitly name:

```sh
agentctx refresh --discover --root /path/to/development --yes
agentctx refresh --dry-run
agentctx refresh
agentctx doctor
```

Discovery is bounded, does not traverse symlinked directories, and does not read
source files or secret/environment values. Profiling recognizes bounded
manifests and shallow filenames, marks generated ownership, and preserves
curated facts, decisions, answers, rules, and links.

Upgrade an existing flat/private Lodestar store without modifying it:

```sh
agentctx migrate-legacy \
  --from /path/to/legacy-store \
  --home /path/to/new-or-existing/.lodestar
agentctx doctor --home /path/to/new-or-existing/.lodestar
```

Migration validates and normalizes the complete graph, builds every index in a
sibling transaction, and promotes the generation only after it is readable.
The guided installer accepts the same source with `--legacy-home`.

## Codex integration and rollback

`agentctx install-codex` modifies only the marked Lodestar block in the active
global `AGENTS.md` or `AGENTS.override.md`. It preserves unrelated instructions
byte-for-byte, preserves native memories, creates staged backups, and writes a
rollback manifest under the selected state home.

Inspect the returned manifest path and roll back with:

```sh
agentctx rollback --manifest /path/from/install-result.json
```

Multi-file operations preflight every target before mutation. Rollback
manifests and restored targets are confined to the selected state home's backup
tree and the paths recorded at installation.

## Safety and privacy

- No telemetry, uploads, remote service, daemon, database, or account.
- No unbounded home-directory or drive crawl.
- No symlink-directory traversal during discovery.
- No automatic reading of `.env`, secrets, source files, or document bodies.
- No default mutation of discovered repositories.
- Canonical-path containment and platform-correct case rules prevent locator
  escapes and cross-project reads.
- Exact reads and linked traversal enforce global/current-project scope.
- Writes validate a complete candidate generation and promote it atomically.
- Installer and Codex changes are staged, backed up, and error-wrapped.

Lodestar can point to detailed repository documentation, but the repository
remains authoritative for source and document contents.

## Troubleshooting

### `agentctx` is not found

Confirm Node.js 22+ and npm are available, then ensure the selected npm prefix's
executable directory is on `PATH`. Re-run the installer and inspect the
`prefix`, `bin`, and `compatibility_bin` fields in its JSON result. On Windows,
the installer also creates compatible `.cmd` shims in `<prefix>\bin`.

### `context-miss`

Lodestar searched only the authorized structured context and did not find an
answer. Inspect the current repository with a targeted search, then add the
durable answer or locator with `agentctx put` so the next agent avoids that
search.

### `scope-denied` or a locator escape error

Select the correct project with `--cwd` or an explicit `--project`. Relative
locators must remain inside the cataloged project root. Cross-project or
external retrieval must be explicit; Lodestar will not silently widen scope.

### `store-write-locked`

Another writer owns the state home. Wait for it to finish and retry. If a
same-host writer crashed, Lodestar reclaims its lock automatically after the
heartbeat becomes stale. Do not delete `.write-lock` while the recorded process
may still be running. Network shares can have weaker filesystem semantics;
prefer a local NTFS/APFS/ext4 state directory and use `agentctx doctor`.

Windows and WSL use separate PID namespaces. A stale cross-runtime lock is
reported as ambiguous instead of being deleted automatically. After confirming
that neither runtime has an active writer, quarantine it explicitly:

```sh
agentctx doctor --repair-lock --force
```

If `current.json` is damaged, `doctor` lists independently validated generation
IDs. Promote only a listed valid generation:

```sh
agentctx doctor --repair-current <64-character-generation-id>
```

### Missing project roots or locators

`doctor` reports unavailable roots and known-broken locator status as warnings.
Mount the drive or correct the curated record, then run `agentctx refresh` and
`agentctx doctor`. A warning for an intentionally offline project does not
expose its records to the active project.

## Development and releases

```sh
npm test
npm run pack:check
node install.mjs --dry-run --skip-codex
```

Continuous integration runs tests and real tarball installation smoke checks on
Windows, Ubuntu, and macOS. A `v<package-version>` tag triggers the release
workflow, which requires matching release notes under `docs/releases/`, reruns
the test suite, packs the npm tarball, writes `SHA256SUMS.txt`, and publishes
both assets to a GitHub release.

See [CHANGELOG.md](CHANGELOG.md) for version history and
[docs/releases/v0.4.4.md](docs/releases/v0.4.4.md) for this release's notes.

## License

Lodestar is available under the [MIT License](LICENSE).
