<p align="center">
  <img
    src="https://raw.githubusercontent.com/VerbalChainsaw/Lodestar/main/docs/assets/lodestar-mark.png"
    alt="Lodestar product mark"
    width="168"
  >
</p>

<h1 align="center">Lodestar</h1>

<p align="center">
  <strong>The deterministic context plane for coding agents.</strong>
  <br>
  One port for identity, rules, repository knowledge, and the exact route to
  whatever comes next.
</p>

<p align="center">
  <a href="https://github.com/VerbalChainsaw/Lodestar/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/VerbalChainsaw/Lodestar"></a>
  <a href="https://github.com/VerbalChainsaw/Lodestar/actions/workflows/ci.yml"><img alt="Cross-platform CI" src="https://github.com/VerbalChainsaw/Lodestar/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT licensed" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Local first" src="https://img.shields.io/badge/context-local--first-55c2ff">
  <img alt="Zero runtime dependencies" src="https://img.shields.io/badge/runtime_dependencies-0-d6a84b">
</p>

<p align="center">
  <img
    src="https://raw.githubusercontent.com/VerbalChainsaw/Lodestar/main/docs/assets/lodestar-hero.png"
    alt="A fixed star routing a linked network of repository knowledge"
    width="100%"
  >
</p>

## Context is not a prompt. It is an operating layer.

Coding agents often begin every session as strangers. They search for
instructions, reopen the same large documents, guess which files matter, and
rediscover commands and decisions that another agent already found. The model
may be intelligent, but the environment keeps making it start from zero.

Lodestar changes the shape of that interaction. It gives every agent one small,
deterministic first place to obtain:

- the rules governing how it should behave;
- the identity of the project beneath its current working directory;
- the commands, constraints, decisions, hazards, and known answers that matter;
- stable links between related pieces of knowledge;
- precise routes to authoritative repository documentation.

The result is not a larger prompt. It is a **context plane**: a durable local
layer between the agent and the filesystem that decides what should be known
first, what can be retrieved exactly, and when repository inspection is
actually necessary.

## The core thesis

Lodestar is built around five ideas.

1. **Route before search.** If the destination is already known, the agent
   should follow a stable link instead of rediscovering it probabilistically.
2. **Identity before action.** An agent should know whose rules apply and which
   project it inhabits before it edits, runs, or recommends anything.
3. **Small context beats ambient context.** The best startup packet is the
   smallest sufficient one, with obvious paths for expansion.
4. **Repositories remain authoritative.** A context system should summarize and
   route to source material, not silently create a second, stale copy of it.
5. **A miss is useful information.** When context is absent, the system should
   say so explicitly, permit targeted inspection, and expose what the canonical
   store needs next.

This is why Lodestar uses stable IDs, a linked record graph, deterministic
indexes, bounded transfer budgets, and explicit context-miss results instead of
making fuzzy search the center of the product.

## The context port

Lodestar is intended to be a stable ingress point for a larger agent operating
environment.

```text
                         LODESTAR
                 one deterministic context port
                                |
          +---------------------+---------------------+
          |                     |                     |
     global identity       project knowledge      retrieval map
     behavior + rules      commands + decisions   links + locators
          |                     |                     |
          +---------------------+---------------------+
                                |
                         coding agent
                                |
                   targeted repository work
```

It does not try to become the entire operating system. It provides the
contract that lets the rest of that system cohere. Different agents, shells,
and repositories can enter through the same port, receive the same structured
truth, and expand it through the same protocol.

| Operating concern | Lodestar's role |
| --- | --- |
| Bootstrap | Supplies required global rules and current-project identity |
| Knowledge | Stores compact operational facts, decisions, commands, and answers |
| Topology | Links related knowledge through stable record IDs |
| Transport | Emits bounded, deterministic JSON rather than large prose dumps |
| Authority | Keeps source code and detailed documents in their owning repositories |
| Recovery | Diagnoses broken state, stale locks, missing roots, and locator drift |
| Feedback | Turns context misses into explicit maintenance signals |

## Why it had to exist

Useful repository knowledge is scattered across instruction files, READMEs,
plans, configuration, source, and past sessions. General search can eventually
find much of it, but “eventually” is the problem. An agent should not sweep a
drive to answer:

- How do I test this repository?
- Which rules apply here?
- What decision has already been made?
- Where is the release procedure?
- Which project does this directory belong to?

The original Lodestar began as a private context engine built to stop that
repeated scavenger hunt. The public edition then had to solve a harder problem:
retain the useful behavior while removing private history, private catalogs,
machine-specific assumptions, and fragile one-off wiring.

That work changed the project substantially. The public package now carries the
retrieval behavior, project tooling, migration, profiling, diagnostics,
rollback, and safety boundaries of the private engine in one universal,
MIT-licensed implementation. Native Windows and WSL use the same package and
can share the same canonical store.

## What we built

| Layer | What exists today |
| --- | --- |
| Linked retrieval | Bounded `start`, exact `get`, graph-aware `resolve`, and scoped `find` |
| Canonical storage | Versioned JSON/JSONL records, stable IDs, deterministic routes, and search indexes |
| Transaction safety | Immutable generations, atomic promotion, audited writes, and rollback on failure |
| Concurrency | Multi-reader/single-writer operation with PID, host, nonce, heartbeat, and stale-lock handling |
| Project intelligence | Bounded discovery, generated-versus-curated ownership, profiling, refresh, and coverage |
| Scope and privacy | Canonical path confinement, cross-project authorization, locator health, and no source ingestion |
| Agent integration | Managed Codex bootstrap blocks with byte-preserving updates, backups, and manifest rollback |
| Portability | Native Windows, WSL, Linux, and macOS behavior from one zero-dependency Node.js package |

This is deliberately more than a wrapper around `grep`. The difficult work is
not finding a string; it is maintaining identity, authority, scope, freshness,
transfer budgets, cross-platform paths, transactional safety, and a retrieval
contract an agent will consistently prefer.

## Before and after

| Without Lodestar | With Lodestar |
| --- | --- |
| Re-scan files at the start of every session | Run one deterministic startup command |
| Load large instruction documents wholesale | Transfer a bounded packet of required context |
| Guess filenames and search broadly | Follow exact record IDs and documentation locators |
| Mix knowledge from unrelated projects | Enforce global and current-project scope |
| Silently fail into more searching | Report a context miss and the targeted next step |

## How an agent uses it

```text
agentctx start --cwd <current-directory>
  |
  +-- required global rules and current-project context
  |
  +-- agentctx get <exact-id>
  |     or agentctx resolve <exact-id>
  |
  +-- agentctx find <terms> --cwd <current-directory>
  |
  +-- targeted repository inspection after a reported context miss
```

The optional Codex adapter installs this lookup contract into a managed block
without replacing unrelated user instructions. New sessions are directed to
Lodestar before broad repository search.

## Engineered as infrastructure

The MVP is gated by more than command-level correctness:

- deterministic startup and retrieval output;
- strict record-count, byte, depth, and scope limits;
- a 100-project material-lift fixture;
- private-engine behavioral parity tests;
- real tarball installation and rollback tests;
- native Windows and WSL execution;
- hosted Windows, Ubuntu, and macOS CI;
- package-content, license, and release-metadata checks.

Lodestar v0.4.4 passes 131 tests under WSL/Linux and the full native Windows
suite with one expected platform-specific symlink skip. The published release
is built from the same commit exercised by the cross-platform workflow.

## Local by design

Lodestar does not upload context, require an account, run a daemon, add a
database, or duplicate entire repositories. Source code and detailed documents
remain authoritative in their repositories; Lodestar stores compact operational
knowledge and precise routes to them.

The current finished package is
[Lodestar v0.4.4](https://github.com/VerbalChainsaw/Lodestar/releases/tag/v0.4.4),
released under the MIT License and tested on Windows, WSL/Linux, and macOS.

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
