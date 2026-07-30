# Lodestar Linked Context MVP Implementation Plan

**Date:** 2026-07-29
**Status:** Ready for execution
**Design:** `docs/superpowers/specs/2026-07-29-lodestar-linked-context-mvp-design.md`

## Goal

Deliver a sanitized, zero-dependency Lodestar package that gives a local coding
agent one deterministic first stop for global rules, current-project context,
linked operational knowledge, and precise documentation routes. The installed
CLI must prove that this path is smaller, safer, and easier than broad
filesystem search.

## Existing Foundation

The repository already contains:

- a fresh Git history with no remote;
- a package allowlist and packed-content privacy test;
- external state-home precedence;
- transactional first-home initialization;
- bounded, deterministic, symlink-safe project discovery;
- 16 passing tests.

The immutable-generation design below intentionally replaces the foundation's
current direct `catalog.json` layout. Preserve its tested precedence,
non-destructive failure behavior, and discovery behavior while migrating the
layout.

## Non-Negotiable Constraints

- Node.js 22 standard library only at runtime.
- JSON/JSONL is canonical; indexes are disposable JSON projections.
- Use TDD for every behavior change: write the focused test, verify RED, add
  minimal production code, verify GREEN, then refactor.
- Never copy private catalogs, records, history, paths, project names, or
  inventory data.
- Never add a remote, push, publish, or choose a public license.
- Never mutate discovered repositories during default operation.
- Never follow directory symlinks or read secret/configuration values.
- Preserve unrelated user configuration byte-for-byte.
- Every writer uses the lock and immutable-generation transaction boundary.
- Every reader captures one generation and stays inside it.

## Locked MVP Budgets

Use explicit versioned constants in `lib/budgets.mjs`:

```js
export const BUDGETS_V1 = Object.freeze({
  start: {
    maxBytes: 16 * 1024,
    maxRequired: 32,
    maxAvailable: 64,
  },
  find: {
    maxResults: 8,
  },
  resolve: {
    defaultDepth: 1,
    maxDepth: 3,
    maxRecords: 24,
    maxBytes: 16 * 1024,
  },
});
```

The private reference startup packet is approximately 4.3 KiB with 6 required
records and 15 available cards, so these ceilings leave material headroom
without allowing unbounded transfer.

---

## Task 1: Lock the Versioned Record and Store Contracts

**Files**

- Modify: `schema/store.json`
- Modify: `templates/records/global.jsonl`
- Create: `lib/budgets.mjs`
- Create: `lib/canonical-json.mjs`
- Create: `lib/validation.mjs`
- Create: `test/validation.test.mjs`
- Modify: `test/state-home.test.mjs`

### RED

Write focused tests proving:

1. every record requires `v: 1`, stable `id`, recognized `kind`, integer
   `priority`, array `scope`, and array `links`;
2. duplicate IDs fail with `duplicate-id`;
3. missing required links fail with `broken-link`;
4. optional missing locators remain valid and produce health warnings;
5. absolute project locators and normalized `..` escapes fail;
6. unknown record versions fail with `unsupported-record-version`;
7. canonical JSON recursively orders object keys while preserving array order;
8. canonical generation input excludes audit timestamps and other volatile
   fields;
9. budget constants match the locked contract.

Run:

```bash
node --test test/validation.test.mjs
```

Confirm failure is due to the missing modules/contracts.

### GREEN

Implement:

- `canonicalStringify(value)` with recursive object-key ordering;
- `validateRecord(record)`;
- `validateGraph({ catalog, records, projectRoots })`;
- structured `ContextError` values with `code` and `detail`;
- versioned store schema and generic bootstrap record with `v: 1`;
- the locked budget constants.

Validation may use metadata reads for locator confinement but must not read
document contents.

### Verify

```bash
node --test test/validation.test.mjs test/state-home.test.mjs
npm test
```

---

## Task 2: Implement Immutable Store Generations

**Files**

- Modify: `lib/state-home.mjs`
- Create: `lib/store-layout.mjs`
- Create: `lib/generation.mjs`
- Create: `test/generation.test.mjs`
- Modify: `test/state-home.test.mjs`

### Target layout

```text
<home>/
  current.json
  generations/
    <content-hash>/
      catalog.json
      schema/store.json
      records/global.jsonl
      records/projects/
      indexes/
  backups/
  events.jsonl
```

`current.json` contains only:

```json
{"v":1,"generation":"<content-hash>"}
```

### RED

Test:

1. first initialization creates one validated immutable generation;
2. its name is the SHA-256 hash of canonical catalog, records, and schema
   inputs;
3. `current.json` points to that generation;
4. identical initialization is idempotent;
5. an invalid existing home is refused without mutation;
6. a simulated failure before pointer promotion leaves the old generation
   active;
7. a simulated pointer rename failure leaves the old pointer readable;
8. readers capture `current.json` once and never mix generation paths;
9. abandoned transaction directories are reported, not recursively deleted as
   setup recovery.

Inject filesystem operations needed to simulate failure; do not patch global
filesystem APIs.

### GREEN

Implement:

- `statePaths(home)`;
- `readCurrentGeneration(home)`;
- `buildGeneration({ home, source, fsApi })`;
- `promoteGeneration({ home, generation, fsApi })`;
- updated `initializeStateHome`.

Build under a nonce-qualified sibling transaction directory. Validate before
renaming into `generations/`, then atomically replace `current.json`. Cleanup
only known transaction files and directories.

### Verify

```bash
node --test test/generation.test.mjs test/state-home.test.mjs
npm test
```

---

## Task 3: Add the Cross-Platform Single-Writer Lock

**Files**

- Create: `lib/write-lock.mjs`
- Create: `test/write-lock.test.mjs`

### RED

Use injected clock, hostname, PID-liveness check, nonce generator, and
filesystem operations. Test:

1. atomic lock-directory acquisition;
2. owner metadata contains nonce, PID, hostname, and start time;
3. heartbeat refresh;
4. matching-nonce release;
5. active same-host writer cannot be evicted due to age;
6. dead same-host PID plus expired heartbeat is quarantined before reacquire;
7. fresh dead-PID heartbeat is not reclaimed;
8. remote-host and ambiguous locks are never auto-reclaimed;
9. bounded waiting returns `store-write-locked` with repair details;
10. a writer cannot release a lock whose nonce changed;
11. competing acquisitions produce exactly one owner;
12. probe cleanup leaves no files behind.

### GREEN

Implement:

- `acquireWriteLock({ home, timeoutMs, staleGraceMs, ...deps })`;
- `withWriteLock(options, operation)`;
- heartbeat lifecycle;
- exact known-file cleanup;
- nonce-qualified stale-lock quarantine;
- `probeWriteSemantics(home)`.

Use `mkdir`, never `flock`, as the acquisition primitive. Treat unsupported or
ambiguous filesystem semantics as a write blocker.

### Verify

```bash
node --test test/write-lock.test.mjs
npm test
```

---

## Task 4: Build Deterministic Route, Search, and Locator Indexes

**Files**

- Create: `lib/indexes.mjs`
- Create: `test/indexes.test.mjs`
- Add fixtures under: `test/fixtures/store/`

### RED

Test literal expected index objects for:

1. record ID to shard-and-scope routes, permitting denial before shard reads;
2. global and per-project normalized search terms;
3. priority-then-ID ordering;
4. aliases, topics, summaries, commands, facts, actions, and locator metadata;
5. no source-document content;
6. deterministic output independent of input record order;
7. locator health states `ok`, `missing`, `unreadable`, and `unchecked`;
8. generation identifier on every index;
9. generation mismatch produces `index-generation-mismatch`;
10. duplicate routes fail;
11. complete rebuild changes only affected deterministic content;
12. no byte offsets appear.

### GREEN

Implement:

- `buildRouteIndex`;
- `buildSearchIndexes`;
- `buildLocatorHealthIndex`;
- `buildIndexes`;
- `validateIndexes`.

Keep builders pure except for explicit metadata probes supplied to locator
health generation.

### Verify

```bash
node --test test/indexes.test.mjs
npm test
```

---

## Task 5: Port the Scoped Retrieval Core

**Files**

- Create: `lib/context-store.mjs`
- Create: `lib/project-roots.mjs`
- Create: `test/context-store.test.mjs`
- Modify: `agentctx.mjs`

Port behavior, not personal defaults or records, from the private reference
engine.

### RED

Test:

1. longest canonical root match selects the current project;
2. no project match returns global context only;
3. Windows comparison is case-insensitive;
4. POSIX canonical comparison is byte-sensitive;
5. duplicate physical roots collapse by realpath/filesystem identity;
6. symlinked aliases do not expand scope;
7. `get` reads the route index and exactly one owning shard;
8. project-scoped `get` requires current or explicitly selected project;
9. cross-project ID attempts produce `scope-denied`;
10. malformed catalog, shard, or index produces stable errors;
11. reads stay inside one captured generation.

Instrument filesystem calls so the test fails if unrelated shards are opened.

### GREEN

Implement:

- `ContextStore.open({ home, cwd, project })`;
- `projectAt(cwd)`;
- `get(id)`;
- scoped shard loading;
- canonical native path handling.

Update `agentctx.mjs` only enough to call a testable `run(argv, deps)` router and
emit one JSON result.

### Verify

```bash
node --test test/context-store.test.mjs
npm test
```

---

## Task 6: Implement `start`, `find`, and Exact Context-Miss Results

**Files**

- Modify: `lib/context-store.mjs`
- Create: `lib/cards.mjs`
- Create: `test/retrieval.test.mjs`
- Modify: `agentctx.mjs`

### RED

Test:

1. `start` returns global rules, project identity, required records, compact
   available cards, warnings, and lookup protocol;
2. unrelated project records never appear;
3. deterministic priority/ID ordering;
4. startup truncates available cards before required records;
5. required records that cannot fit fail with `startup-budget-exceeded`
   instead of being silently omitted;
6. startup reports omitted available IDs and never exceeds 16 KiB;
7. known-broken locator health appears on returned records/cards;
8. exact indexed `find` returns at most eight ranked cards;
9. vocabulary reformulation is deterministic and scoped;
10. empty results return `context-miss` with project and targeted next action;
11. `--json` writes JSON only;
12. CLI errors are one structured JSON object on stderr with nonzero exit code.

### GREEN

Implement:

- `ContextStore.start`;
- `ContextStore.find`;
- compact card projection;
- byte-aware deterministic truncation;
- CLI commands `start`, `get`, `find`, and `project`.

Do not silently broaden scope after a miss.

### Verify

```bash
node --test test/retrieval.test.mjs
npm test
```

---

## Task 7: Add Bounded Link Resolution

**Files**

- Modify: `lib/context-store.mjs`
- Create: `lib/resolve.mjs`
- Create: `test/resolve.test.mjs`
- Modify: `agentctx.mjs`

### RED

Test:

1. default depth-one breadth-first traversal;
2. explicit depths two and three;
3. depth above three fails before reads;
4. cycles terminate by record ID;
5. duplicate links return one record;
6. priority does not change breadth-first graph order;
7. scope-denied links are reported and not followed;
8. record and 16 KiB byte budgets truncate deterministically;
9. `truncated`, `omitted_ids`, and `reason` are exact;
10. an omitted ID remains retrievable with `get`;
11. known-broken locator status remains attached.

### GREEN

Implement pure bounded BFS plus `ContextStore.resolve` and the CLI command.

### Verify

```bash
node --test test/resolve.test.mjs
npm test
```

---

## Task 8: Prove Material Lift Before More Installer Work

**Files**

- Create: `test/material-lift.test.mjs`
- Create: `test/fixtures/lift/`
- Create: `test/fixtures/scale/`
- Create: `docs/evaluation.md`

### Fixtures

Create synthetic stores with:

- global and project-specific behavior rules;
- 100 projects and no more than 10,000 total records;
- an active project with 50 curated and 50 generated records;
- overlapping terms in unrelated projects;
- linked commands, constraints, decisions, and documentation locators;
- stale/missing locators;
- path escapes and symlink aliases;
- a large repository instruction document used only for baseline byte
  comparison.

### RED

Write tests for all eleven material-lift gates in the design. The test must
initially reveal missing performance or transfer behavior, not merely assert
that fixture files exist.

Add an instrumentation boundary that records:

- commands needed;
- bytes returned;
- shards opened;
- elapsed operation time;
- deterministic output hash.

### GREEN

Make only the minimal retrieval/index changes needed to satisfy the gates.
Record:

- reference environment;
- median of repeated warm runs;
- absolute local thresholds;
- portable CI regression multiplier.

Do not hard-code a 50 ms claim unless the measured reference baseline supports
it.

### Verify

```bash
node --test test/material-lift.test.mjs
npm test
```

---

## Task 9: Implement Validated, Atomic `put`

**Files**

- Create: `lib/put.mjs`
- Create: `test/put.test.mjs`
- Modify: `lib/context-store.mjs`
- Modify: `agentctx.mjs`

### RED

Test:

1. JSON input from exact flag, file, and stdin;
2. new curated record insertion;
3. validated replacement by stable ID;
4. generated record edit refused without `--take-ownership`;
5. explicit ownership promotion;
6. graph/index validation before promotion;
7. route/search indexes rebuilt in the new generation;
8. event log contains hashes and operation metadata, never record contents;
9. simultaneous puts cannot lose an update;
10. failed write leaves the old generation active;
11. idempotent identical put produces no new generation.

### GREEN

Implement `put` through `withWriteLock` and the immutable-generation builder.
The CLI never edits shards in place.

### Verify

```bash
node --test test/put.test.mjs
npm test
```

---

## Task 10: Build Guided `init` and Starter Curation

**Files**

- Modify: `agentctx.mjs`
- Create: `lib/init.mjs`
- Create: `lib/prompts.mjs`
- Create: `lib/project-identity.mjs`
- Create: `test/init.test.mjs`

Reuse the completed bounded discovery module.

### RED

With injected streams and temporary homes, test:

1. existing suggested development roots only;
2. custom and repeated `--scan-root`;
3. missing-root reprompt;
4. deterministic discovery preview;
5. cancel/EOF performs zero writes;
6. Ctrl-C exits 130 with no promoted state;
7. explicit number selection and `--select all`;
8. `--dry-run` produces exact plan with zero writes;
9. `--json` emits no prompts;
10. stable catalog-side project IDs survive display-name/root changes;
11. ID collision suffixes are deterministic;
12. starter curation previews recognized commands, constraints, decisions, and
    documentation filenames;
13. skipping curation remains valid;
14. discovered repositories are unchanged;
15. initialization emits the required final JSON object.

### GREEN

Implement:

- interactive and non-interactive plan construction;
- immutable catalog-side IDs;
- generated starter records and curated user-confirmed records;
- one locked generation promotion after final confirmation.

Do not install Codex integration yet; return it as a planned later step.

### Verify

```bash
node --test test/init.test.mjs test/discovery.test.mjs
npm test
```

---

## Task 11: Add Resilient Profiling and `refresh --discover`

**Files**

- Create: `lib/profiler.mjs`
- Create: `lib/refresh.mjs`
- Create: `test/profiler.test.mjs`
- Create: `test/refresh.test.mjs`
- Modify: `agentctx.mjs`

### RED

Test profiling:

1. recognized manifests only, with explicit size caps;
2. no `.env` or arbitrary source reads;
3. native Windows paths remain native;
4. WSL drive translation occurs only under WSL;
5. missing/unreadable projects return per-project failures;
6. command, locator, manifest, and directory caps;
7. standard generated routes and ownership labels;
8. curated records remain untouched.

Test refresh:

1. generated metadata replacement;
2. locator health update by metadata only;
3. `--discover` previews new projects and requires confirmation;
4. existing project roots may be relinked without changing project ID;
5. removed generated records are pruned only when curated links remain valid;
6. linked orphan returns an actionable warning;
7. `--dry-run` exact diff and zero writes;
8. total profiling failure does not promote;
9. partial success promotes with warnings;
10. full index rebuild is deterministic;
11. one lock/generation transaction covers the operation.

### GREEN

Port only generic bounded metadata logic from the private profiler. Implement
refresh as plan, validate, lock, build, and promote.

### Verify

```bash
node --test test/profiler.test.mjs test/refresh.test.mjs
npm test
```

---

## Task 12: Install Codex Integration Safely

**Files**

- Create: `lib/codex-install.mjs`
- Create: `test/codex-install.test.mjs`
- Modify: `lib/init.mjs`

### Managed block

```text
<!-- lodestar:start v1 -->
BOOT=agentctx start --cwd <cwd>
APPLY=required[]
LOOKUP=agentctx.get|agentctx.resolve>agentctx.find>repo.targeted>repo.broad
FAIL=repo.targeted+report.context_error
<!-- lodestar:end -->
```

### RED

Test:

1. `CODEX_HOME`, default home, and explicit `--codex-home` discovery;
2. no existing global instruction file;
3. unrelated `AGENTS.md` content preserved byte-for-byte;
4. active `AGENTS.override.md`;
5. exact managed-block update;
6. malformed/partial block refuses mutation;
7. CRLF preservation;
8. backup before atomic replacement;
9. simulated rename failure leaves original active;
10. second install is idempotent;
11. `--dry-run` returns exact diff;
12. native memories remain enabled by default;
13. Lodestar-only memory mode requires exact explicit confirmation.

### GREEN

Implement only the managed instruction block. Do not replace
`developer_instructions` or unrelated configuration.

### Verify

```bash
node --test test/codex-install.test.mjs
npm test
```

---

## Task 13: Add Actionable Doctor and Adapter Rollback

**Files**

- Create: `lib/doctor.mjs`
- Create: `lib/rollback.mjs`
- Create: `test/doctor.test.mjs`
- Create: `test/rollback.test.mjs`
- Modify: `agentctx.mjs`

### RED

Doctor tests:

- current pointer and generation integrity;
- record/schema/index generation validity;
- duplicate IDs, broken links, invalid scopes, locator escapes;
- known-broken locator status;
- unreachable project roots;
- stale/ambiguous writer locks;
- orphaned transaction/quarantine directories;
- CLI wrapper resolution;
- managed Codex block;
- runtime/package compatibility;
- startup budgets;
- write-semantics probe cleanup;
- exact `code`, affected target, and `repair` for every error.

Rollback tests:

- timestamped backup manifest with paths and hashes, never contents;
- latest and explicit backup selection;
- refusal after active-file drift;
- explicit `--force`;
- atomic restore failure leaves active file intact;
- idempotent already-restored result.

### GREEN

Implement doctor as read-only except for exact opt-in repair commands. Rollback
applies only to adapter-managed files, never store generations or repositories.

### Verify

```bash
node --test test/doctor.test.mjs test/rollback.test.mjs
npm test
```

---

## Task 14: Verify the Installed Package and Cross-Platform Contract

**Files**

- Modify: `package.json`
- Modify: `README.md`
- Create: `docs/installation.md`
- Create: `docs/privacy.md`
- Create: `docs/troubleshooting.md`
- Create: `test/package.test.mjs`
- Create: `.github/workflows/test.yml`

### RED

Write an external-tarball test that:

1. packs into a temporary directory;
2. installs under a separate temporary prefix;
3. invokes npm's generated `agentctx` wrapper;
4. initializes a temporary Lodestar home against synthetic projects/Codex
   home;
5. runs `doctor`;
6. runs `start`, `get`, `resolve`, and `find`;
7. performs `put` and `refresh --discover`;
8. proves real user homes and repositories were not read or changed.

### GREEN

Complete package metadata, executable handling, documentation, and a Node 22
CI matrix for Ubuntu, macOS, and Windows. Every test injects temporary homes.

README must make the preferred path unmistakable:

```text
start > get/resolve > scoped find > targeted repository inspection
```

Document local Codex CLI/desktop/IDE support and explicitly exclude Codex Cloud
access to a local store.

### Final Verification

```bash
npm test
npm pack --dry-run
```

Build and install a real tarball away from the source tree, then run the
installed wrapper through the full synthetic workflow.

Run the repository and history privacy gates through the test helper, which
constructs forbidden markers without embedding them in distributable files:

```bash
node test/privacy-scan.mjs --tree .
node test/privacy-scan.mjs --history
```

Expected:

- all tests pass;
- only intended package files appear;
- no private marker appears in distributable content or history;
- no remote exists;
- no real Codex home or discovered repository changed;
- material-lift gates pass at the locked scale;
- the installed CLI uses the generated npm wrapper successfully.

## Completion Gate

The MVP is complete only when:

- one state home supplies global rules and current-project context;
- stable links retrieve the right structured knowledge without drive search;
- exact retrieval reads one routed shard;
- startup and expansion remain within fixed budgets;
- scope escape and cross-project leakage tests pass;
- concurrent writes cannot corrupt or lose data;
- new projects can be discovered and curated without repository mutation;
- Codex is safely directed to prefer Lodestar;
- doctor and rollback make failures repairable;
- installed-package, cross-platform, privacy, and material-lift gates pass.
