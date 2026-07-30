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

## v0.7.0 is live

**Less payload. Less wandering. Measured payback. Zero local noise.**

Lodestar v0.7.0 keeps required context complete while shrinking the real
71-project startup packet by **70.1%**, exposes package and PATH drift before
installation, accelerates deep audits, and removes false locator/root noise.
It stays local-first, dependency-free, deterministic, and compatible with the
version 1 store.

<p align="center">
  <a href="https://github.com/VerbalChainsaw/Lodestar/releases/tag/v0.7.0"><strong>Download v0.7.0</strong></a>
  ·
  <a href="docs/releases/v0.7.0.md">Read the release notes</a>
  ·
  <a href="docs/benchmarks.md">Inspect the benchmarks</a>
  ·
  <a href="SECURITY.md">Report a vulnerability</a>
</p>

### Why this version matters

v0.7.0 makes the context plane cheaper to use and easier to trust. Agents
receive complete rules plus compact optional routes, operators can see package
transitions before setup changes anything, and diagnostics focus on actionable
failures instead of harmless alternate paths or absent build outputs.

| Advantage | What it means in practice |
| --- | --- |
| Smaller hand-off | The real canonical startup packet fell from **16,300 to 4,879 bytes** while preserving all six required records |
| Less agent wandering | Exact routing replaced broad search while inspecting **90.63% fewer files** and **97.62% fewer bytes** in the standard profile |
| Measured payback | The final 100-project run saved **5.305 ms** and avoided **1,023,653 inspected bytes** while adding 3,234 evidence bytes |
| Predictable context | Stable IDs, deterministic indexes, and bounded evidence give agents the same scoped answer path every time |
| Strong project isolation | Retrieval returned **zero cross-project records**, even in the 500-project stress profile |
| Faster maintenance | Bounded-concurrent deep inspection was **61.7% faster** on the same retained history; repaired local audit was **92.3% faster** end to end |
| Safer upgrades | Preflight exposes installed/target versions, transition, active command, and PATH shadowing and refuses accidental downgrade |
| Recovery you can verify | Integrity seals, deep diagnostics, snapshots, restore, and recoverable quarantine provide a tested route back |
| Confidence at scale | The 500-project profile preserved **4/4 answers**, inspected **98.63% fewer bytes**, and saved **21.045 ms** at the median |

### What shipped

| Area | v0.7.0 capability |
| --- | --- |
| Startup | 5 KiB hard ceiling, complete required context, compact optional routing cards |
| Installation | Visible transition and command-path drift with downgrade protection |
| Diagnostics | Runtime versions, actionable root semantics, bounded-concurrent deep audit |
| Profiling | Existing, project-relative generated locators; side-effect-free help and real dry-run |
| Recovery | Sealed generations, verified snapshots, restore, and recoverable quarantine |
| Compatibility | Version 1 store, exact retrieval, no daemon, no telemetry, zero runtime dependencies |

### Release scorecard

| Gate | Verified result |
| --- | ---: |
| Linux/WSL test suite | **203/203 passed** |
| Canonical deep doctor | **0 errors · 0 warnings · 0 blockers** |
| Real startup packet | **4,879 / 5,120 bytes** |
| Runtime dependencies | **0** |
| Retrieval correctness | **4/4 answers preserved** |
| Project isolation | **0 cross-project records** |
| Normal-scale payoff | **1,023,653 bytes + 5.305 ms saved** |
| Stress-scale payoff | **8,274,085 bytes + 21.045 ms saved** |
| Release publication gate | **Ubuntu + macOS + Windows + CodeQL + provenance** |

The GitHub release is created only after its exact tagged commit passes hosted
install, startup, deep diagnostics, snapshot, restore, maintenance, performance,
CodeQL, checksum, and provenance gates. See the
[v0.7.0 verification record](docs/releases/v0.7.0.md) for the complete scope
and honest claim boundary.

## Benchmark results

Lodestar is designed to reduce environmental work around coding-agent reasoning while preserving correctness. Current cross-platform benchmark results:

| Metric | Standard profile | 500-project stress profile |
| --- | ---: | ---: |
| Correct answers | **4/4 → 4/4** | **4/4 → 4/4** |
| Files inspected | **64 → 6** (−90.63%) | **256 → 6** (−97.66%) |
| Repository bytes inspected | **1.0 MiB → 24.3 KiB** (−97.62%) | **8.0 MiB → 111.8 KiB** (−98.63%) |
| Median elapsed time | **15.424 → 10.119 ms** (−34.39%) | **62.596 → 41.551 ms** (−33.62%) |
| Broad repository search | **Yes → No** | **Yes → No** |
| Cross-project leakage | **0** | **0** |

The benchmark suite measures retrieval efficiency, determinism, project isolation, and runtime overhead. It does **not** claim universal improvement in LLM reasoning quality. See the full [benchmark results](docs/benchmarks.md), [performance methodology](docs/performance.md), and [paired evaluation design](docs/evaluation.md).

The fixed routing cost is not a universal latency win. Fresh 25-sample tests on
repositories with only 8–16 tiny documents were **18.82–138.46% slower** than a
successful direct scan, even though Lodestar still inspected fewer files and
bytes. The measured advantage appears as repository size and ambiguity grow;
timings are observational and machine-specific.

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
| Project intelligence | Lossless registry consolidation, bounded discovery, profiling, refresh, readiness, and coverage |
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
- a paired 100-project
  [material-lift benchmark](docs/evaluation.md) against broad repository
  discovery;
- private-engine behavioral parity tests;
- real tarball installation and rollback tests;
- native Windows and WSL execution;
- a required hosted Windows, Ubuntu, and macOS CI gate;
- package-content, license, and release-metadata checks.

Release evidence and local/native test totals are recorded in
[docs/benchmarks.md](docs/benchmarks.md). The release workflow will not publish
until Windows, Ubuntu, and macOS checks pass on the exact tagged commit.

Current local evidence is 203/203 WSL/Linux tests, zero canonical deep-doctor
issues, a complete isolated packed lifecycle, and passing 10, 100, and
500-project gates. Every published tag independently earns its native Windows
and hosted lifecycle result.

Run the comparison yourself:

```bash
npm run benchmark:lift
```

Run the extended scale and operation-level performance suite:

```bash
npm run benchmark:performance
```

See the transparent [performance methodology](docs/performance.md) for fixture
sizes, p50/p95 interpretation, cache semantics, and comparison rules.

### The category benchmark

The deterministic suites prove retrieval mechanics. Lodestar also ships a
provider-neutral live-agent harness that tests the larger product claim:

```text
Lodestar-enabled
vs.
unmanaged agent context
```

It gives fresh model sessions realistic repository questions amid stale plans,
conflicting commands, nested instructions, generated artifacts, and
cross-project traps. It measures answer correctness, evidence, time, tokens,
files, bytes, tool calls, wrong turns, leakage, confidence calibration, and
reproducibility.

The suite intentionally includes a tiny repository where direct inspection may
tie or win and a stale-Lodestar case where structured context can lose. The
goal is to find the crossover point, not manufacture a perfect chart.

Preview the complete randomized trial matrix without starting a model or
spending anything:

```bash
npm run benchmark:category -- \
  --config benchmarks/category/config.example.json
```

Paid execution requires a separate `--execute` flag, an absolute output
directory, an explicit maximum cost, and per-runner cost estimates. Completed
trial IDs are resumable, raw evidence is retained locally, and a `STOP` file
halts before the next trial.

See the [category benchmark methodology](docs/category-benchmark.md) for the
runner protocol and the
[registered benchmark plan](docs/plans/2026-07-30-lodestar-category-benchmark-plan.md)
for hypotheses, losing cases, analysis, and publication rules.

## Local by design

Lodestar does not upload context, require an account, run a daemon, add a
database, or duplicate entire repositories. Source code and detailed documents
remain authoritative in their repositories; Lodestar stores compact operational
knowledge and precise routes to them.

Published Lodestar releases come only from exact tagged commits that pass
hosted Windows, Ubuntu, and macOS CI. Each release includes a SHA-256 checksum
and GitHub provenance attestation for the package.

## Requirements and platform support

- Node.js 22 or newer, with npm
- Native Windows 10/11, WSL, Linux, or macOS
- PowerShell for `install.ps1`, or a POSIX shell for `install.sh`

The same package and store format are used on every supported platform.

## Quick start

Download `lodestar-agent-context-0.7.0.tgz` and
`SHA256SUMS.txt` from the
[v0.7.0 release](https://github.com/VerbalChainsaw/Lodestar/releases/tag/v0.7.0),
verify the checksum, and install:

```sh
npm install --global ./lodestar-agent-context-0.7.0.tgz
agentctx --version
agentctx --help
agentctx init
agentctx doctor
agentctx start --cwd /path/to/project
```

The supported public distribution is the provenance-attested GitHub release
tarball. The package name is not currently published through the npm registry.

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
--allow-downgrade
--dry-run
-h, --help
-v, --version
```

Run `node install.mjs --dry-run --skip-codex` to inspect an installation plan
without writing files. Preflight uses read-only npm-root and prefix queries to
report the installed version, target version, transition, active `agentctx`
command, and whether another installation shadows the target. Downgrades and
unrecognized-version replacements fail closed unless `--allow-downgrade` is
explicit.

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

Operational commands emit JSON. `--help` and `--version` provide conventional
human-readable CLI information without opening a state home. Failures emit a
stable error code and details to stderr and exit nonzero. A lookup that has no
result reports `context-miss` and directs the agent to a targeted repository
inspection rather than silently widening scope.

## Commands

| Command | Purpose |
| --- | --- |
| `agentctx --help` / `agentctx help <command>` | Show the command catalog or exact usage for one command. |
| `agentctx --version` | Print the installed Lodestar version. |
| `agentctx init` | Create a valid state home from packaged templates. Add `--discover --root <path>` to preview starter curation and `--yes` to confirm it. |
| `agentctx start --cwd <path>` | Return the current project's required context and compact optional routes within a 5 KiB hard limit. |
| `agentctx get <id>` | Return one exact, scope-authorized record. |
| `agentctx resolve <id> [--depth <1-3>]` | Return an exact record and its bounded linked graph. |
| `agentctx find <query> --cwd <path>` | Search structured fields in global/current-project scope. |
| `agentctx project [selector]` | Return the current project or a matching project card. |
| `agentctx put --json '<record>'` | Validate and transactionally write one curated record. Use `--file <path>` or stdin instead; generated records require `--take-ownership`. |
| `agentctx doctor [--deep]` | Validate pointers, generations, graph, every index, scopes, roots, locators, locks, startup budgets, write semantics, durability, and project readiness, and report the running package version. Deep mode verifies checksums, source identity, and rebuilt index content. |
| `agentctx coverage [--project <id>]` | Report completeness and freshness. Add `--max-age-days <n>` and `--require-ready` for a CI gate. |
| `agentctx ask <intent> <project>` | Query a project context using a recognized intent. |
| `agentctx profile-projects [--project <id>]` | Refresh bounded generated project metadata without overwriting curated records. Add `--dry-run` for a non-mutating preview. |
| `agentctx refresh` | Profile projects; equivalent to `profile-projects`. Supports `--dry-run`. |
| `agentctx refresh --discover --root <path> --yes` | Discover and add projects under explicit roots after confirmation. |
| `agentctx migrate-legacy --from <path>` | Import a legacy flat Lodestar store without changing the source. |
| `agentctx migrate-projects --from <registry.json>` | Preview with `--dry-run`, then losslessly merge a bounded project registry. `--force` retains deliberate full replacement. |
| `agentctx snapshot --to <path>` | Create and verify a portable active-generation snapshot outside the state home. |
| `agentctx snapshot --verify <path>` | Recheck a snapshot's file set, checksums, generation identity, graph, and indexes. |
| `agentctx restore --from <path> --home <new-path>` | Verify and restore a snapshot to a new path. Add `--dry-run` to validate without writing. |
| `agentctx maintain [--apply]` | Report storage, retention, audit, and source-drift status. Mutation is explicit and deeply preflighted. |
| `agentctx recover <generation> [--promote]` | Validate and restore one quarantined generation; activation remains a separate explicit choice. |
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

New generations are sealed by a deterministic SHA-256 file manifest, and
record/catalog/store resource limits are enforced before persistence. Use
`agentctx doctor --deep` to recompute generation identity, verify sealed bytes,
and rebuild indexes for semantic comparison.

## Integrity, snapshots, and maintenance

Lodestar's normal read path stays small; lifecycle work remains explicit:

```sh
agentctx doctor --deep
agentctx snapshot --to /backups/lodestar-snapshot
agentctx snapshot --verify /backups/lodestar-snapshot
agentctx maintain
agentctx maintain --retain 10 --apply
```

`maintain` is read-only unless `--apply` is present. It reports store bytes,
retained generations, audit growth, and bounded project-source drift. Applied
retention moves excess generations to recoverable quarantine and never removes
the active generation. `agentctx recover <generation>` restores a quarantined
generation after deep validation; add `--promote` only when it should become
active. v0.6 does not expose an irreversible quarantine purge.

Restore refuses to overwrite any existing path:

```sh
agentctx restore \
  --from /backups/lodestar-snapshot \
  --home /path/to/new-lodestar-home \
  --dry-run
agentctx restore \
  --from /backups/lodestar-snapshot \
  --home /path/to/new-lodestar-home
agentctx doctor --home /path/to/new-lodestar-home --deep
```

For durability levels, resource budgets, retention semantics, source drift,
audit checkpoints, and scheduling details, see
[docs/maintenance.md](docs/maintenance.md).

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

Consolidate an existing project list into Lodestar without creating a second
runtime authority:

```sh
agentctx migrate-projects \
  --from /path/to/projects.json \
  --home /path/to/.lodestar \
  --dry-run
agentctx migrate-projects \
  --from /path/to/projects.json \
  --home /path/to/.lodestar
agentctx profile-projects --home /path/to/.lodestar
agentctx coverage --home /path/to/.lodestar --require-ready
```

The default path merges by prior registry identity, exact project name, and
normalized roots. It preserves existing Lodestar IDs and unrelated curated or
generated records. Repeat imports with unchanged input are no-ops. Descriptions,
activity, commands, entrypoints, endpoints, and memory anchors become bounded
linked portfolio records; only the portfolio card is startup-visible.

Unknown project fields fail with `registry-fields-unsupported` so information
is never discarded silently. Add a bounded adapter for the field, then retry.
The external registry is a migration or refresh source, not a database
Lodestar consults at runtime.

`coverage` reports the ten context categories plus freshness for generated and
imported records. `doctor` warns when reachable projects are incomplete, stale,
or unverified. Refresh generated context and curate real knowledge gaps before
using `--require-ready` as a release gate.

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
- New generations carry per-file SHA-256 manifests and synchronize staged data
  before promotion.
- Restore targets must be new paths; retention is dry-run-first and quarantines
  before explicit age-gated deletion.
- Installer and Codex changes are staged, backed up, and error-wrapped.
- Release actions are pinned to immutable commit SHAs; published packages carry
  GitHub artifact provenance attestations in addition to SHA-256 checksums.

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

For suspected disk corruption, use `agentctx doctor --deep`. Restore a verified
snapshot to a new state home rather than editing a generation in place.

### Missing project roots or locators

`doctor` reports a root issue only when none of a project's cataloged roots is
reachable. Mount the drive or correct the project, then run `agentctx refresh`
and `agentctx doctor`. Unavailable alternate roots remain visible in generated
project hazards without turning a healthy multi-machine project into a warning.

## Development and releases

```sh
npm test
npm run pack:check
node install.mjs --dry-run --skip-codex
```

Continuous integration must pass tests and real tarball installation smoke
checks on Windows, Ubuntu, and macOS. A `v<package-version>` tag triggers the
release workflow, which requires matching release notes under `docs/releases/`,
reruns the test suite, packs the npm tarball, writes `SHA256SUMS.txt`, creates
an artifact provenance attestation, and publishes both assets to a GitHub
release.

See [CHANGELOG.md](CHANGELOG.md) for version history and
[docs/releases/v0.7.0.md](docs/releases/v0.7.0.md) for this release's notes.

## License

Lodestar is available under the [MIT License](LICENSE).
