# Lodestar Linked Context MVP Design

**Date:** 2026-07-29
**Status:** Locked for implementation
**Audience:** Product and implementation reviewers
**Supersedes:** The product emphasis, but not the safety requirements, in the
Lodestar Shareable Edition implementation handoff

## 1. Purpose

Lodestar gives local coding agents one overwhelmingly easy, deterministic first
place to obtain:

- global behavior rules;
- user preferences that are appropriate to expose to an agent;
- current-project identity;
- repository commands, constraints, decisions, and known answers;
- links between related knowledge;
- precise routes to detailed documentation.

The MVP is not primarily a project scanner or a general search engine.
Discovery, profiling, installation, and packaging support the central product:
a canonical linked context store that transfers the smallest sufficient packet
of relevant information to an agent.

Lodestar should be preferable to broad filesystem search because it is faster,
more precise, cheaper in tokens, structured for machine consumption, and
explicit about what to retrieve next.

## 2. Product Contract

The agent-facing path is:

```text
agentctx start --cwd <cwd>
        |
        v
global rules + project identity + required entrypoints
        |
        v
agentctx get <id> or agentctx resolve <id>
        |
        v
exact structured knowledge or precise documentation locator
        |
        v
targeted repository inspection only after a reported context miss
```

Lodestar is authoritative for its structured operational knowledge and graph.
The owning repository remains authoritative for source code and detailed source
documents. Lodestar may summarize and route to those documents, but it does not
silently duplicate or ingest entire repositories.

The default lookup order is:

```text
agentctx start
> agentctx get / agentctx resolve
> agentctx find within authorized context
> targeted repository lookup
> broader repository lookup only when still necessary
```

Broad home-directory or drive search is never part of normal Lodestar
operation.

## 3. Design Principles

### 3.1 One canonical store

All Lodestar-managed records live under one state home:

```text
explicit --home
> LODESTAR_HOME
> AGENT_CONTEXT_HOME
> <homedir>/.lodestar
```

The state home contains the project catalog, global records, project record
shards, schemas, indexes, audit events, and backups. Package code and per-user
state remain separate.

### 3.2 Stable IDs form the graph

Records link to stable record IDs, not to filenames. Moving a shard or changing
its storage layout must not invalidate relationships.

Project identity is also independent of its display name and filesystem root.
`init` assigns an immutable project ID in the central catalog. Renames and moves
update catalog aliases and roots without changing that ID or any linked record
IDs. Lodestar does not write identity files into discovered repositories during
default setup.

Example:

```json
{
  "v": 1,
  "id": "p:music-app:commands",
  "kind": "command",
  "priority": 850,
  "scope": ["project:p:music-app"],
  "commands": {
    "test": "npm test",
    "dev": "npm run dev"
  },
  "links": [
    "p:music-app:constraints",
    "p:music-app:entrypoints"
  ]
}
```

### 3.3 Compact records before prose

Facts, actions, commands, decisions, constraints, aliases, and routes use
structured fields. A record may contain a short summary, but large prose is not
the default transfer format.

Detailed documentation is represented by a precise locator:

```json
{
  "v": 1,
  "id": "p:music-app:doc:release",
  "kind": "index",
  "scope": ["project:p:music-app"],
  "summary": "Release procedure and rollback requirements",
  "locators": [
    {
      "type": "file",
      "path": "docs/release.md",
      "anchor": "rollback"
    }
  ],
  "links": ["p:music-app:commands", "p:music-app:constraints"]
}
```

Relative locators resolve from the cataloged project root. External locators
must be explicit and pass validation.

Lodestar maintains last-known locator health in a generated health index.
`refresh` validates path containment, file existence, and file type using
metadata operations. It does not read target document contents merely to
validate anchors. `start`, `get`, and `resolve` expose known-broken locator
status so an agent never mistakes a stale route for a verified one. A broken
locator result recommends a scoped `agentctx find <topic>` before targeted
repository inspection.

### 3.4 Small initial packet, obvious expansion

`start` returns only:

- required global rules;
- current project identity;
- required project records;
- compact cards for optional entrypoints;
- the allowed lookup protocol;
- setup or context warnings.

Every returned card includes enough metadata to decide whether to call `get` or
`resolve`. The agent should not need to guess filenames or search directories.

### 3.5 Safe scoped retrieval

Normal reads are limited to global records plus the current project. Cross-
project retrieval requires an explicit project selection or record ID and must
be visible in the result.

## 4. MVP Commands

### 4.1 `agentctx start --cwd <path>`

Resolves the current project by longest matching native root, loads global and
project entrypoints, and emits the startup packet.

Required properties:

- deterministic ordering;
- machine-readable JSON;
- explicit `required` and `available` arrays;
- exact project resolution;
- warnings rather than broad search;
- enforced byte and record budgets;
- no unrelated-project records.

### 4.2 `agentctx get <id>`

Returns one exact record after scope validation. It does not perform fuzzy
search or graph traversal.

### 4.3 `agentctx find <query> --cwd <path>`

Searches indexed structured fields within global and current-project scope.
Search covers IDs, aliases, topics, summaries, commands, facts, actions, and
locator metadata. It does not scan repository files.

Results are deterministic, ranked, compact cards. An empty result reports a
context miss and recommends targeted repository inspection.

Search uses generated sidecar indexes rather than scanning every record shard:

```text
indexes/routes.json
indexes/search/global.json
indexes/search/<project-id>.json
indexes/locator-health.json
```

The route index maps each record ID to its owning shard. Each search index maps
normalized terms to ordered record IDs and contains no source-document
contents. Indexes are deterministic build products, rebuilt and atomically
promoted with their source records. They carry a store-generation identifier;
generation mismatches are reported as repairable index errors. Byte-offset
indexes are deliberately excluded from the MVP because ordinary atomic shard
rewrites would invalidate them.

### 4.4 `agentctx resolve <id>`

Expands links from one exact record.

Defaults:

- depth: 1;
- hard maximum depth: 3;
- deterministic breadth-first traversal;
- cycle detection by record ID;
- global/current-project scope enforcement;
- strict record-count and byte budgets.

The result identifies omitted links when a budget is reached. The agent may
request a specific omitted ID with `get`.

### 4.5 `agentctx init`

Creates a valid state home, discovers candidate projects, previews selections,
profiles bounded metadata, and installs the managed Codex adapter only after
confirmation.

Initialization is an onboarding mechanism. It must not be the only way to add
or curate useful knowledge.

After project selection, initialization offers a short starter-curation step
for the highest-value entrypoints: test command, development command, critical
constraints, architecture documentation, and active decisions. Suggested
values come only from recognized metadata and filenames; users preview them
before promotion. Skipping curation remains valid and does not mutate the
discovered repository.

### 4.6 `agentctx refresh`

Refreshes generated project metadata and locator health without overwriting
curated records.

It:

- rescans explicitly configured roots within discovery bounds;
- optionally discovers newly added projects with `--discover`, previews them,
  and requires confirmation before catalog insertion;
- updates generated aliases, markers, commands, and locators;
- reports missing or moved project roots;
- preserves curated facts, decisions, answers, rules, and links;
- previews changes with `--dry-run`;
- promotes validated changes atomically.

It does not ingest source code or arbitrary document contents.

### 4.7 `agentctx put`

Maintains curated structured records through validated JSON input. Writes are
atomic and audited. The MVP does not require an interactive editor.

`put` remains in the MVP because direct manual JSONL edits bypass validation,
atomic promotion, index rebuilding, locking, and audit history. It accepts JSON
through a file, exact flag, or standard input; it does not require an
interactive record editor.

### 4.8 `agentctx doctor` and `agentctx rollback`

Doctor validates store integrity, graph integrity, scopes, locators, budgets,
runtime compatibility, and the Codex adapter. Rollback restores adapter files
from installation manifests without rolling back unrelated repository data.

## 5. Record and Graph Model

Every record has:

- `v`: record-schema version, initially `1`;
- `id`: globally unique stable identifier;
- `kind`: schema-recognized record type;
- `scope`: global or explicit project scope;
- `priority`: deterministic startup and result ordering input;
- `links`: zero or more stable record IDs.

Records may also have:

- `facts`;
- `action`;
- `commands`;
- `aliases`;
- `topics`;
- `summary`;
- `locators`;
- kind-specific structured fields.

The MVP retains JSON and JSONL as the canonical representation. It does not add
a database, dependency, daemon, embedding store, or vector index.

### 5.1 Entrypoints

Each project has one entrypoint record linking to the records most likely to be
needed during agent startup:

```text
project identity
  -> commands
  -> constraints
  -> architecture
  -> active decisions
  -> documentation index
```

Global entrypoints link to behavior rules, user work preferences, vocabulary,
and shared operating constraints.

Entrypoints are curated graph roots, not dumps of every record.

### 5.2 Link validation

State promotion fails when changed records introduce:

- duplicate IDs;
- broken required links;
- records outside their declared scope;
- malformed locators;
- invalid routes;
- entrypoint cycles that cannot fit the hard traversal bounds.

Optional missing locators produce actionable warnings when the owning
repository is temporarily unavailable.

Locator validation rejects absolute paths unless the locator is explicitly
typed as external. Project-relative locators are resolved against the
canonical project root and rejected when normalization or realpath resolution
escapes that root.

### 5.3 Index schemas

Indexes are disposable, deterministic projections of the catalog and record
shards. Version 1 uses these shapes:

`indexes/routes.json`:

```json
{
  "v": 1,
  "generation": "<content-hash>",
  "records": {
    "p:music-app:commands": {
      "shard": "records/projects/p-music-app.jsonl",
      "scope": ["project:p:music-app"]
    }
  }
}
```

`indexes/search/<scope>.json`:

```json
{
  "v": 1,
  "generation": "<content-hash>",
  "scope": "project:p:music-app",
  "terms": {
    "test": ["p:music-app:commands"]
  }
}
```

`indexes/locator-health.json`:

```json
{
  "v": 1,
  "generation": "<content-hash>",
  "locators": {
    "p:music-app:doc:release#0": {
      "status": "ok",
      "checked_path": "docs/release.md"
    }
  }
}
```

Allowed health states are `ok`, `missing`, `unreadable`, and `unchecked`.
Unsafe or escaping locators are validation errors and never enter a promoted
generation. Search term arrays are ordered by priority and then record ID.
Route scopes are copied from validated records so unauthorized IDs can be
rejected before an unrelated shard is opened.
Full index rebuild is the MVP strategy; builders expose scope-level functions
so incremental rebuilds can be introduced later only if profiling justifies
them. Indexes contain shard routes, not byte offsets.

## 6. AI-Preferred Integration

Codex receives one managed instruction block:

```text
BOOT=agentctx start --cwd <cwd>
APPLY=required[]
LOOKUP=agentctx.get|agentctx.resolve>agentctx.find>repo.targeted>repo.broad
FAIL=repo.targeted+report.context_error
```

The adapter syntax and contract are fixed for the MVP:

1. Bootstrap from Lodestar.
2. Apply required rules from the startup packet.
3. Follow exact record links before searching.
4. Use scoped Lodestar search before repository search.
5. Search the repository only after a context miss.
6. Report missing context so the canonical store can improve.

The adapter preserves unrelated user instructions byte-for-byte and preserves
native Codex memories by default.

Preference is earned as well as instructed. The Lodestar path must be:

- faster than broad repository discovery in the evaluation fixtures;
- smaller than loading equivalent large instruction documents;
- deterministic across identical stores and inputs;
- sufficient to answer the defined fixture questions;
- explicit when it cannot answer.

## 7. Data Flow

### 7.1 Startup

1. Resolve the state home.
2. Load and validate the catalog.
3. Resolve `cwd` and cataloged roots to canonical real paths, then select the
   longest path-boundary match using platform-correct case rules.
4. Load global and project entrypoint shards only.
5. Traverse required links within the startup budget.
6. Return required records, available cards, project identity, warnings, and
   lookup instructions.

On Windows, canonical path comparison is case-insensitive. On other platforms,
canonical `realpath` output is compared byte-for-byte; filesystem identity
checks collapse aliases that resolve to the same physical directory.

### 7.2 Exact retrieval

1. Resolve the requested stable ID through the validated route index.
2. Enforce global/current-project scope.
3. Read the single owning shard.
4. Validate and return the record.

### 7.3 Link resolution

1. Retrieve the starting record.
2. Traverse links breadth-first.
3. Deduplicate IDs and stop cycles.
4. Stop at depth, record, or byte limits.
5. Return records plus explicit truncation metadata.

### 7.4 Context miss

1. Return an empty or incomplete result with a stable context-miss code.
2. Include the current project and attempted scope.
3. Recommend a targeted repository lookup.
4. Never silently broaden to the home directory or another project.

### 7.5 Concurrent access

Lodestar is multi-reader and single-writer.

- Immutable store snapshots live under `generations/<content-hash>/`.
- `current.json` names the active validated generation and is replaced
  atomically. A reader captures it once per command and reads only that
  generation.
- Writers acquire an exclusive state-home lock with bounded waiting and stale
  lock diagnostics.
- A writer builds records and indexes in a sibling transaction directory,
  validates the complete generation, renames it into `generations/`, and only
  then atomically replaces `current.json`.
- Readers see either the previous valid generation or the new valid generation,
  never partially rewritten JSON.
- Competing writers fail with an actionable `store-write-locked` result rather
  than overwriting one another.

The exact zero-dependency lock protocol is:

1. Atomically create `<home>/.write-lock/` with `mkdir`.
2. Write `owner.json` containing a random nonce, PID, hostname, and start time.
3. Refresh a heartbeat file while the transaction runs.
4. On contention, wait only to the configured deadline.
5. Treat a same-host lock as reclaimable only when `process.kill(pid, 0)`
   confirms the PID is absent and its heartbeat exceeds the stale grace period.
6. Atomically rename a reclaimable lock directory to a nonce-qualified
   quarantine path before attempting acquisition; never delete an unresolved
   lock in place.
7. Never auto-reclaim a remote-host lock or one whose liveness is ambiguous.
   Return diagnostics and an exact `doctor` repair command.
8. Release only a lock whose nonce still matches the writer.

PID liveness is therefore not the sole stale-lock signal, and lock age alone
can never evict a live writer. `doctor` probes required `mkdir` and rename
semantics without leaving probe files. State homes on filesystems that cannot
demonstrate those semantics are reported unsupported for writes rather than
being assumed safe.

### 7.6 Generated and curated ownership

Generated records are labeled with their generator and may be replaced or
pruned by `refresh`. Curated records are never overwritten by discovery or
profiling. When generated metadata disappears, `refresh` removes the obsolete
generated record only after checking that no curated link would break; otherwise
it reports an orphan requiring review.

`put --take-ownership` explicitly promotes a generated record to curated
ownership before applying the supplied replacement. No implicit edit changes
ownership.

## 8. Material-Lift Evaluation

The MVP is not complete merely because commands execute. It must pass a local,
deterministic evaluation suite.

Fixtures contain multiple projects with:

- overlapping terminology;
- global and project-specific rules;
- linked decisions and commands;
- a large source document reachable through a locator;
- missing and stale locators;
- intentionally unrelated private records.

The scale fixture contains at least 100 cataloged projects and no more than
10,000 total records. Its active project contains up to 50 curated and 50
generated records, which defines ordinary MVP use for budget testing.

For each fixture task, the test records:

- correct project resolution;
- correct required records;
- correct linked answer or locator;
- absence of unrelated-project data;
- command count needed to reach the answer;
- bytes transferred;
- elapsed local execution time;
- deterministic output hash.

Required MVP gates:

1. All defined startup questions are answerable from `start` plus at most two
   exact retrieval commands.
2. No fixture requires broad filesystem search when the answer exists in
   Lodestar.
3. Cross-project leakage is zero.
4. Identical inputs produce byte-identical JSON after excluding declared
   volatile fields.
5. Startup stays within a fixed byte budget and reports truncation rather than
   exceeding it.
6. Exact retrieval reads only the catalog/index and owning shard, not every
   record file.
7. A context miss produces an actionable targeted-search instruction.
8. Cross-project IDs, `..` locator escapes, symlink aliases, and
   platform-specific case variants cannot bypass scope.
9. Concurrent reads during `put` or `refresh` observe a complete old or new
   generation, and competing writers cannot lose updates.
10. `start` and scoped retrieval remain within their versioned latency budgets
    with at least 100 projects cataloged.
11. Context misses, stale locks, index-generation mismatches, known-broken
    locators, and generated-record orphans produce stable error codes and exact
    repair or fallback instructions.

Version 1 transfer ceilings are:

- startup: 16 KiB, 32 required records, and 64 available cards;
- find: 8 result cards;
- resolve: depth 1 by default, depth 3 maximum, 24 records, and 16 KiB.

These limits give material headroom over the reference engine's approximately
4.3 KiB startup packet while remaining bounded. Required startup records are
never silently dropped: if they cannot fit, `start` returns
`startup-budget-exceeded`. Available cards and resolved links may be truncated
with explicit omitted IDs.

Initial latency thresholds will be established from repeated runs of the
checked-in reference fixture and environment, then retained as versioned test
constants. Portable CI also enforces relative regression limits so slower
runners do not produce meaningless failures.

## 9. Safety and Privacy

The Shareable Edition retains all existing safety invariants:

- no private repository history or catalog is copied;
- no remote, publication, telemetry, or upload;
- no unbounded home-directory crawl;
- no traversal of symlinked directories;
- no automatic secret or `.env` content reading;
- no default mutation of discovered repositories;
- no destructive Codex configuration replacement;
- backups and atomic writes for changed configuration;
- native Codex memories preserved unless explicitly disabled;
- per-project failures isolated during discovery and profiling.

Packed-content and Git-history privacy gates remain release blockers.

## 10. Implementation Delta

The existing Shareable Edition handoff remains the implementation base. The MVP
revision makes these focused changes:

1. Add an explicit task to port and sanitize the proven `start`, `find`, `get`,
   validation, routing, and scoped-read engine from the private reference.
2. Add `resolve` with bounded deterministic graph traversal.
3. Add deterministic route, scoped-search, and locator-health indexes.
4. Add `refresh --discover` that separates generated metadata from curated
   knowledge.
5. Add immutable catalog-side project identity, canonical path confinement,
   single-writer locking, and atomic store generations.
6. Add graph, scope, locator, and transfer-budget validation.
7. Add the material-lift evaluation suite before treating installation and
   packaging as complete.
8. Update the Codex managed block and documentation to make exact linked
   retrieval the preferred path.

The revision does not introduce a new persistence technology or replace the
existing zero-dependency Node.js architecture.

The MVP does not compress shards or indexes. At the defined scale, compression
adds decompression and random-access complexity without demonstrated retrieval
lift; it remains a profiling-driven future option.

## 11. Recommended Implementation Order

1. Complete the sanitized repository and external-state foundation.
2. Port the scoped retrieval engine with behavioral parity tests.
3. Add immutable project identity, deterministic indexes, graph validation,
   locking, and bounded `resolve`.
4. Establish evaluation fixtures and baseline transfer budgets.
5. Add guided initialization, starter entrypoint curation, and
   generated/curated record separation.
6. Add resilient profiling and `refresh --discover`.
7. Add safe Codex integration.
8. Add doctor, rollback, external package installation tests, cross-platform
   CI, and release documentation.
9. Run material-lift, privacy, package, and history gates.

This order proves the product's central value before investing further in
installer polish.

## 12. Explicit Non-Goals

- General desktop or drive search.
- Source-code ingestion.
- Full-document duplication by default.
- Natural-language semantic or vector search.
- Automatic agent autonomy outside explicit scoped commands.
- Cloud access to a local Lodestar store.
- Database, daemon, watcher, GUI, or web account.
- Replacement of repository source control or native Codex memory.

## 13. Review Questions

The external review should challenge:

1. Whether stable-ID JSON/JSONL links are sufficient for the expected scale.
2. Whether source-document locators preserve the “one place” experience without
   creating stale indirection.
3. Whether the startup packet and expansion protocol make Lodestar genuinely
   preferable to broad search.
4. Whether scope enforcement prevents cross-project leakage.
5. Whether the evaluation gates demonstrate material lift rather than only
   implementation correctness.
6. Whether any proposed command or subsystem can be removed while preserving
   the product contract.
