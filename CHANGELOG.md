# Changelog

## 1.4.1 - 2026-08-15

- Establish `g:lodestar:required-governance` as the sole required global operating
  doctrine, generated from `managed-assets/governance.json` together with the complete
  human-readable recovery copy in `docs/GOLDEN-RULES.md`.
- Raise Lodestar's general startup default from 16 KiB to 24 KiB so the canonical
  governance still leaves the doctor's required 4 KiB of project headroom. Explicit
  host budgets remain authoritative; the Codex adapter keeps its measured 16 KiB limit.
- Harden Codex startup and stop-hook recovery against oversized continuity content while
  preserving complete required governance under the adapter's explicit host boundary.
- Make the package bootstrap the canonical source for minimal native agent files. The
  shipped `AGENTS.md` stub now matches that bootstrap byte for byte, so changes to the
  supported Lodestar commands cannot leave an older hand-written redirect behind.
- State the ownership boundary explicitly: a project may keep its durable operating
  rules in a full native agent file, or use the minimal Lodestar bootstrap when startup
  is proven to carry every required rule. It must not maintain both as competing
  rulebooks.
- Reject retired handoff verbs anywhere in published model-facing assets. This catches
  stale instructions such as `handoff save`, `handoff validate`, and `handoff clear`
  before they can be installed into Codex, Claude, Hermes, or OpenCode clients.

## 1.4.0 - 2026-08-14

- The startup budget is yours to set. 16 KiB is about 4K tokens — generous for a small
  local model, negligible for a 200K-context host — and it was applied uniformly to
  every host with no way to change it. It is now a default, not a wall.
- Four sources, most immediate to most durable: `--startup-budget`,
  `LODESTAR_STARTUP_BUDGET`, a project `config` record, a global `config` record. A
  project setting beats a machine one because it is the narrower statement.
- `start` states the budget in force and where it came from, in `data.budget`, so a
  raise is deliberate and visible rather than silent drift. That visibility is what keeps
  the budget a forcing function now that it is adjustable.
- `doctor` measures against the configured budget instead of its own copy of the number,
  and reports against the strictest budget any project in the registry runs under.
- A budget outside 8 KiB–256 KiB is treated as a typo and ignored, so a stray value can
  neither strangle startup nor quietly defeat the bound.
- `config` records are never projected as context — carrying one would spend the budget
  describing the budget.

## 1.3.0 - 2026-08-14

- `start` never refuses to run. Required records larger than the 16 KiB budget used to
  throw `resource_limit`, which stopped every session in the project over a marking
  mistake often made somewhere else entirely — a global record is charged to all
  projects. Startup now demotes instead, in a fixed order, and always returns.
- Shedding demotes to a stub rather than deleting. Every record the projection cannot
  carry is still named by `id`, `name` and `kind` in `data.available`, so one
  `lodestar get` recovers exactly the right one. Dropping records outright and pointing
  at `lodestar find --limit 50` made the agent search and re-read more than the budget
  ever saved, which is the opposite of what a bounded projection is for.
- Shed in value order: optional context, then advisory work, then stubs of optional
  records, then required records, and the governance record last. A required record's
  content now outranks an optional record's name.
- `put` reports the startup cost of marking a record required, naming the heaviest
  project affected. It reports and never refuses, so a bulk import cannot fail partway.

## 1.2.7 - 2026-08-14

- Measure the startup budget where it is actually spent. `doctor` only ever counted
  global required records, but `start` sheds on the global total *plus* the project's
  own. A registry could report healthy while its heaviest project sat a few hundred
  bytes from refusing to start — the exact outage the check exists to predict. It now
  reports the worst project, its startup cost, and how many bytes remain.
- Stop `doctor` from disagreeing with itself. `startup_budget.healthy` compared against
  half the budget while the issue fired below 4 KiB of headroom, so an ordinary registry
  printed `"healthy": false` nested inside `"healthy": true` with an empty issue list
  and nothing to act on. One threshold now drives both.
- Name the way out in every continuity refusal. `handoff_not_armed`,
  `handoff_conflict` on an armed lane, and `handoff_pending` on disarm each state a
  rule and used to stop there; an agent reading only the rule concludes the operation is
  impossible and abandons Lodestar for the raw CLI. Each now carries the command that
  resolves it.
- Answer `lodestar help` and `lodestar version`. Only `--help` and `--version` worked,
  so the two commands anyone types first returned `unknown_command`.

## 1.2.6 - 2026-08-14

- Stop a claimed recovery from wedging a project. A baton that has been handed to a
  successor is already delivered, but it kept blocking `handoff now` for every session
  except that successor, and no other session could take the claim over. If the
  successor never saved its own baton — it crashed, the host closed, or it was never
  the intended reader — the project could never save continuity again, with no command
  to recover.
- Guard only what is worth guarding: an *unclaimed* recovery written by another session.
  A pending baton is self-resolving, because the next session in the project claims it.
- Let a session supersede its own undelivered baton instead of failing with
  `A pending or claimed project recovery is owned by another session`, which named the
  wrong situation when the owner was the caller.
- Accept the continuity phrase however it is typed. `$handoff now`, `/handoff now`,
  `Handoff Now`, `lodestar handoff now` and `handoff now.` are the same command, but only
  the exact lowercase spelling was authorized, so agents that habitually prefix a sigil
  were refused and fell back to the raw CLI. The whole prompt must still be the command
  and nothing else — `don't handoff now` and `handoff now please` remain unauthorized.

## 1.2.5 - 2026-08-14

- Recognize a tool however the host namespaces it. `lodestar_x`,
  `lodestar__lodestar_x` and `lodestar/lodestar_x` are the same tool, but an
  attestation was bound to the exact spelling the hook happened to receive. A
  mismatch surfaced as `Invalid, expired, mismatched, or replayed host attestation`,
  which says nothing about naming and makes a working plugin look broken.
- Compare the canonical tool name on both sides of the attestation, so a token minted
  under one spelling still executes under another while remaining bound to its
  session, turn, cwd, and arguments.

## 1.2.4 - 2026-08-14

- Let a resumed session read its own baton. `lodestar_handoff_status` mutates nothing
  but still required the exact spoken phrase, so checking continuity — the first thing
  an agent does on resume — was denied and surfaced only as
  `Missing host attestation`. Reads are now attested directly; every command that
  writes a lane still requires the phrase.
- Fail closed instead of crashing when the plugin data directory cannot be written. A
  hook that throws takes the host session with it.

## 1.2.3 - 2026-08-14

- Give advisory work the same host-attested identity continuity already used. Codex
  injects no session id into spawned shells, so every identity-requiring write failed
  with `identity_required` and work presence was dead in the harness it was built for.
  `lodestar_work_start|done|status` now carry the exact host session.
- Keep concurrent sessions distinct. Work records are keyed by actor, so any shell-side
  guess at the caller captured another session's marker and the next write erased it.
  The CLI now refuses without an explicit `--session` rather than guessing.
- Stop redaction corrupting its own output. A secret pattern with no capture group
  passed the match offset to the replacer, writing it into the text as `9[REDACTED]`.
- Derive the Codex plugin version from its manifest instead of a literal, so an
  installed build cannot claim a release it is not.

## 1.2.2 - 2026-08-13

- Name the largest required records when startup exceeds its 16 KiB budget. `start`
  is the first command of every session, so the failure previously stopped all work
  without saying which record to shrink.
- Bound the pending review queue to a rolling window of 100 candidates per project
  and report every eviction. A queue past a few screens is one nobody triages.
- Add `doctor.checks.startup_budget`, measured on the bytes `start` actually
  serializes, with a `startup_budget_low` warning raised while there is still room
  to act.
- Add `lodestar pending list|add|promote|drop`, a quarantine scope startup never
  reads, so capture costs the startup budget nothing and only promotion spends it.

## 1.2.1 - 2026-08-13

- Remove three deleted instruction templates from the packaged reference table.
  They named private projects and pointed at files the package no longer ships.
- Fail the release check when packaged documentation cites a template that is not
  in the artifact.

## 1.2.0 - 2026-08-13

- Generate one required governance record and one canonical bootstrap from the
  managed assets, return the rule on every startup, and transactionally manage
  explicitly configured client bootstrap files alongside the skill payload.
- Fold work presence, continuity, and durable decisions into the Lodestar
  umbrella skill while keeping one executable and one SQLite authority.
- Bundle the managed client skills and instruction templates in the Lodestar
  package, with one `skills install|sync|verify|remove` lifecycle for Codex,
  Claude, Hermes, and OpenCode.
- Add session-isolated `handoff arm|status|checkpoint|now|disarm`, atomic
  next-session startup claiming, append-only `decision` events, and deterministic
  FACTS/DEAD startup projection.
- Import supported historical knowledge, work, decision, continuity, and current
  Lodestar state through one checksummed, backup-first, idempotent manifest.
- Keep WSL skill staging and backups on the Linux filesystem, translate client
  roots at the one-shot shim boundary, and verify the installed shim is
  executable before returning success.
- Preflight and stage the complete managed-skill batch before client mutation,
  compensate handled cross-client failures in reverse order, and keep each
  stage on its destination filesystem.
- Exercise the packed package through every public command family, the real
  Codex MCP stdio transport, real AgentLink subprocess delegation, and a
  disposable live-scale latency/concurrency benchmark.
- Open the current-schema migration probe read-only and document the exact
  mutation boundary for startup, schema migration, state, and skill commands.

## 1.1.0 - 2026-08-13

- Unify startup context, durable knowledge, advisory work presence, and
  cross-session handoff behind one `lodestar` executable and one JSON envelope.
- Add monotonic database and record revisions allocated inside every mutation
  transaction.
- Normalize Windows and WSL project paths and cross the Windows-owned one-shot
  runtime boundary from WSL.
- Preserve original direct-content and wrapped record forms through one
  universal output adapter.
- Replace specialized continuity persistence with typed universal records;
  schema-v2 migration drops its old tables only when all are empty.
- Include the Lodestar Codex plugin for one startup injection and the validated,
  redacted natural `handoff now` flow.
- Retire old service, discovery, successor-creation, and separate-suite runtime
  surfaces.
- Rebuild the GitHub and npm front page and publish the packed executable with
  cross-platform verification.
- Normalize WSL, MSYS, and Cygwin path arguments at the Windows process
  boundary, including `--db`, `--file`, and legacy import sources.
- Route WSL execution through `/init` so Lodestar remains available when a
  second distro changes the shared `WSLInterop` binary-format registration.
- Enforce the 16 KiB startup budget before transaction commit, cap oversized
  handoff heads, report exact omitted counts, and roll back an unreturned
  handoff claim.
- Make the complete test suite portable across Windows, Linux, and macOS
  fixtures under the required Node 24.15 runtime.

## 1.0.3 - 2026-07-31

- Put the central original-to-1.0 product comparison near the top of the
  GitHub and npm front page.
- Credit the original Lodestar for proving structured project context while
  explaining, in first person, why the reduced SQLite architecture is the
  stronger product for Lodestar's current job.
- Show the concrete reduction from custom generations, lifecycle machinery,
  installers, readiness claims, provider experiments, and multiple executables
  to one database, one CLI, direct facts, and provider-neutral JSON.
- Keep every runtime command, schema, database behavior, migration contract,
  package file, dependency boundary, and executable identical to 1.0.2.

## 1.0.2 - 2026-07-31

- Publish a clearer GitHub and npm front page with an honest product summary,
  direct install path, current verification badges, and the zero-setup first
  write contract above the fold.
- Add original launch hero and social-card artwork plus reusable announcement
  copy.
- Attach both launch graphics to the GitHub release alongside the exact npm
  tarball and checksums.
- Improve npm discovery metadata without adding dependencies, executables, or
  runtime behavior.
- Keep the database schema, storage behavior, CLI commands, migration contract,
  and all other runtime semantics identical to 1.0.1.

## 1.0.1 - 2026-07-31

- Remove the mandatory first-run setup step: the first structurally valid
  `lodestar put` now initializes an absent or resumable zero-byte database
  before writing.
- Keep invalid first writes, every read-only command, help, version, and
  deletion against a missing registry side-effect free.
- Reuse the existing exclusive reservation, bounded busy window, and SQLite
  transactions so overlapping first writers cannot replace the winning
  registry. Contention beyond that bound remains an explicit, retryable
  `database_busy` error.
- Keep `lodestar init` as an optional idempotent command for deliberately
  creating an empty registry or retrieving the bootstrap contract.

## 1.0.0 - 2026-07-31

- Replace the v0.7 generation platform with one local SQLite database.
- Publish one JSON-first executable, `lodestar`, with nine commands.
- Store records, exact aliases, explicit links, and source observations in five
  small tables.
- Keep `known`, `known_empty`, `unavailable`, `unknown`, and `stale` distinct.
- Add bounded deterministic search, one-hop link retrieval, canonical export,
  read-only diagnostics, and atomic put/delete transactions.
- Add a read-only, one-way v0.7 importer with dry-run, integrity validation,
  deterministic identifier mapping, loss reporting, and source-change checks.
- Harden no-replace database creation, SQLite byte/timestamp constraints,
  bounded diagnostics and growing-file reads, fail-closed stored JSON,
  incremental export limits, bounded migration reporting, concurrent imports,
  explicit unknown-commit handling with exact database identifiers, and exact
  v0.7 Unicode shard compatibility.
- Reject forged SQLite reserved-schema objects, enforce byte-exact streaming
  through typed-array intrinsic checks, make error normalization total for
  hostile in-process values, and keep JSON error codes aligned with exit
  status.
- Preserve published database reservations across definite failures, separate
  rollback-confirmed import failures from ambiguous commits, and make doctor
  apply the complete stored-value contract used by public reads.
- Preserve legacy locator paths and available locator-health observations as
  explicit source rows without converting path probes into content claims;
  report every ambiguous, orphaned, or unretained observation exactly once.
- Validate packaged documentation links and every public help path without
  touching database state.
- Remove generations, commit pointers, writer heartbeats, snapshots,
  quarantine, readiness scoring, project discovery, provider experiments,
  installer logic, benchmark commands, and every executable except `lodestar`.

## Retired v0.x platform

Versions 0.4.0 through 0.7.0 implemented the earlier generation-based context
platform. Their detailed changelogs, release notes, architecture, and package
artifacts remain available in their git tags and published GitHub releases.
They are not retained as dormant runtime code in Lodestar 1.0.
