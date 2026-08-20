# Q&A log — 2026-08-19 Lodestar prune + gap scan session

Session: DSH sandbox (CodexSandboxUsers ACL: read-only on the live database).
Rule 2 ledger: the live Lodestar decision log is available to read but NOT to write
from this sandbox (ACL grants RX only). Entries below are recorded here; the ACCEPTED
block at the bottom is portable for a non-sandboxed session to transcribe with
`lodestar decision set`.

## Answered questions

| Q | A | Date |
| --- | --- | --- |
| Priority order for the Lodestar work? | Finish the uncommitted prune first, then debug/gap scan. | 2026-08-19 |
| Should we capture todos / scratchpad / defect list into Lodestar (tags + serialization)? | Defects: yes (structured, durable, project-scoped, links to decisions). Todos: yes, as a per-actor live board record replaced atomically (NOT per-item records, NOT per-transition events). Scratchpad: no — keep out of the durable DB; existing LODESTAR NOTE -> pending -> promote stays as the promotion discipline. Tags: `data.tags` array + `find --tag` filter (`json_each`), no schema change. | 2026-08-19 (pending build approval) |
| How do we compel agents to emit the capture markers consistently? | You cannot compel an LLM by instruction alone. Levers: (1) put the marker grammar in the startup snapshot as a fill-in working-state block, (2) expose record actions as MCP tool calls so capture is mechanical, (3) tolerant marker parsing in the Stop hook, (4) next-startup feedback so capture is visible, (5) no refusal gates. Details in session reply. | 2026-08-19 (recommendation; build pending approval) |

## Open questions (need Director answers before proceeding)

1. Build the todo + defect tranche (two command families, --tag filter, projection
   changes)? If yes, I will run codeplan first (real mechanism choices exist).
2. `.backups/` (412 files / 19.4 MB, untracked, all from 2026-08-19): keep until the
   branch lands, or clear? Untouched by me — never delete without authorization.
3. 106 legacy `decision` records in the live DB (pre-event-model, inert, read-only via
   get/find): archive them, or leave as-is?

## Operational discovery (verified)

Live DB writes from sandboxed agent processes fail with SQLITE_READONLY (errcode 8):
ACL `Gigaflex\CodexSandboxUsers:(I)(RX)` on `%LOCALAPPDATA%\Lodestar\lodestar.db`.
Non-sandboxed sessions retain Full Control. Intentional machine boundary
(matches 2026-08-19T151446 live-readonly-cutover) — do not weaken.

## Prune changes shipped this session (working tree, uncommitted)

- Retired skills install/sync/remove and agents apply/remove -> read-only verify/template.
- Removed startup-budget policy: unbounded default; env + config-record sources gone;
  only explicit per-call `--startup-budget` targets optional projection.
- Removed hardcoded byte/item ceilings from schema v4, validation, doctor; legacy DDL
  keeps old caps only for migration identification.
- Removed dead code: `jsonBytes`, `truncateUtf8`, bounded-input readers
  (`readStreamBounded`, `readTextFileBounded`, `readHandleBounded`); stream safety
  tests ported to the live `readStreamComplete` path.
- Docs: schema.md v3->v4 heading, limitations.md stale skill-install paragraph,
  v1.4.2 release-note budget claim, CHANGELOG Unreleased entries.
- Verified: 173/173 tests pass, asset parity passes, e2e smoke 20/22 (2 = smoke
  expectation bug: decision key `db:engine` normalizes to `db-engine`; product correct),
  baton claim/replay verified through the real CLI.

## ACCEPTED decisions to transcribe (portable block)

```text
lodestar decision set qa:analysis:priority "finish prune, then debug/gapscan" --reason "Director answer to priority question" --session <session> --agent maxwell --harness dsh
lodestar decision set prune:skills-agents read-only --reason "Lodestar no longer owns external skill dirs or AGENTS.md; install sync remove and apply remove retired; verify and template only" --session <session> --agent maxwell --harness dsh
lodestar decision set startup:budget unbounded --reason "start returns all optional context by default; only explicit per-call --startup-budget targets optional projection; env and config-record sources removed" --session <session> --agent maxwell --harness dsh
lodestar decision set limits:policy none-without-boundary --reason "byte and item ceilings removed from schema validation and doctor; only real host transport boundaries remain" --session <session> --agent maxwell --harness dsh
lodestar decision set schema:version 4 --reason "uncapped universal record model; legacy DDL retained only so migrations can identify and rebuild prior shapes" --session <session> --agent maxwell --harness dsh
lodestar decision set json:canonical iterative --reason "recursive canonical stringify replaced with iterative traversal; depth and node caps removed while cycle type and sparse-array validation retained" --session <session> --agent maxwell --harness dsh
```
## Decision-marker tranche (2026-08-19, in progress)

Codeplan: constrained mode, V1 selected (event-model extension + marker rendering +
hook capture via one-shot CLI). PLAN-OUT in session log.

Shipped (working tree):
- `decision set` accepts `--status blocked`; new `decision status <key> accepted|blocked`.
- Replay derives facts / blocked / dead; projection renders golden-rule markers:
  `[DECISION key=... status=ACCEPTED|BLOCKED value=... date=... reason="..."]`,
  `[SUPERSEDED key=... by=... value=... date=... reason="..."]`,
  `[DEAD key=... value=... date=... reason="..."]`.
- Old events without status replay as accepted (backward compatible).
- Stop hook captures bracketed markers from the final message via one-shot CLI:
  value-bearing DECISION -> set; bare status -> status (unknown key -> pending
  candidate); DEAD/SUPERSEDED -> drop. Idempotent per op; redacted; never blocks.
- Docs: README, decisions.md reference (mirrored to codex-plugin via
  build-managed-assets --write, parity check passes), CHANGELOG Unreleased.
- Tests: decision.test.mjs 6/6 in-process; marker parser verified directly;
  plugin marker e2e written but needs an escalated run (spawns the CLI/hook).

Verification status (honest):
- In-process (no approval needed): 15/22 test files green, decision 6/6, json 7/7,
  parser OK, asset parity OK.
- PENDING approval (escalation gate unresponsive at session end): full escalated
  `node --test` run; plugin marker e2e; 4 spawn/timing tests in cli/database/
  release/windows-install (environment artifacts, passed pre-tranche);
  5 spawn-dependent files (concurrency, e2e, package, plugin, work-identity).
## Round 2 verification evidence (2026-08-20)

Spawn-free verification completed (no approval needed):
- CLI-level end-to-end on a temp DB: `decision set --status blocked`, `decision status`
  (block/unblock), marker projection rendering, idempotent replay (2 vs 2), `start`
  carries the same projection, `doctor` healthy with 4 decision events. Raw projection:
  `[DECISION key=db-engine status=ACCEPTED value=postgres date=2026-08-20 reason=centralized writes]`
  and `[DECISION key=gate status=BLOCKED value=closed date=2026-08-20]`.
- In-process suite: 15/22 files green; decision.test.mjs 6/6; parser direct check OK;
  asset parity OK.
- STILL PENDING (approval gate unresponsive): escalated full `node --test` run;
  plugin marker e2e (hook spawn); 5 spawn-dependent files; 4 spawn/timing tests in
  cli/database/release/windows-install (environment artifacts, passed pre-tranche).
## Round 2 (2026-08-20) outcome

- Escalated full-suite attempt: approval gate STILL unresponsive (7 failed attempts
  across 2 rounds + 1 ask_user_question timeout). Not a code failure.
- Spawn-free verification re-confirmed green: decision.test.mjs 6/6, json 7/7, doctor,
  agent-state, pending, continuity, queries, records, skills, agents all pass in-process;
  asset parity OK; CLI marker surface verified end-to-end on a temp DB (set --status,
  status verb, marker rendering, idempotency, start projection, doctor healthy).
- Blocker (approval gate) has persisted 2 consecutive goal rounds; per policy, blocked
  may be marked from round 3.
## RESOLVED — full verification passed (2026-08-20)

- Director returned and approved escalations. Full escalated suite: **178/178 pass**,
  including the plugin marker e2e (Stop-hook capture), all spawn-dependent files
  (plugin, e2e, concurrency, package, work-identity), and the environment-artifact
  tests (cli, database, release, windows-install).
- All 7 Q&A/prune decisions transcribed into the live Lodestar ledger via escalated
  run (verified: 8 facts in project:p:agent-context scope). NOTE: the CodexSandboxUsers
  RX ACL on the live DB binds only confined runs; danger-full-access executes as the
  interactive user and can write. Confirmed by observation.
- Marker tranche objective COMPLETE.
## DEAD power-word hardening (2026-08-20)

Director: "DEAD proved to be the real power-word, negating an idea that changes is
the most powerful marker."
Implemented: every dead item now renders the golden-contract negation sentence under
its marker — `<old> is DEAD; do not propose, use, or restore it. Use <current>.`
(or `It has no replacement.`), with the reason. Verified: 178/178 suite green;
demo projection shows both SUPERSEDED and DEAD forms with negation sentences.
Docs: decisions.md reference + CHANGELOG updated; mirrors regenerated; parity OK.
OPEN DESIGN QUESTION (not built): revival stickiness — should `decision set` of a
value currently listed DEAD be rejected (kill stays closed unless the Director
revives) or remain an ordinary deliberate revival (current behavior)? Golden rules
say Director-issued kills stay closed unless the Director revives; the ledger does
not yet distinguish killer authority. Awaiting Director answer.
## Revival stickiness implemented (option 3, 2026-08-20)

Director chose authority-aware kills. Implemented and verified (179/179 suite):
- Direct CLI set/drop default `--authority director`; hook-captured markers always
  pass `--authority agent`.
- Director-issued kills: `reopen=director` on the marker; a different session's
  `decision set` of the same value is rejected with `dead_decision_revival` and an
  actionable message; replacement values always allowed; the killing session can
  revive.
- Agent-issued kills reopen by evidence; pre-authority kills replay as open.
- Live demo confirmed: agent revival rejected, replacement accepted, projection
  renders `reopen=director` + negation sentence.
- Also per Director: .backups and the 106 legacy decision records are LEFT ALONE.
## Marker technology unified (2026-08-20)

Director: "unify the marker technology so that it's consistently formatted, placed,
and clear."
Codeplan: V1 selected (single shared grammar module) over V2 (duplicate+parity);
beatBaseline yes.
Implemented and verified (184/184 suite green):
- src/markers.mjs is the ONE grammar: formatMarker + parseMarkers + parseLegacyNotes.
  Core rendering (src/decision.mjs) and plugin capture (lodestar-runtime.mjs) both
  use it — display, capture, storage, and docs cannot drift.
- Canonical kinds DECISION/DEAD/SUPERSEDED/NOTE; attribute order key, status, by,
  value, date, reason, reopen, text; one bare-or-quoted value rule; status parses
  case-insensitively, displays uppercase; date YYYY-MM-DD.
- NOTES now use the canonical [NOTE text="..."] marker; the historical
  "LODESTAR NOTE:" line is tolerated by capture (legacy tests still pass).
- Placement rule documented: ledger markers render in the startup projection
  (FACTS -> BLOCKED -> DEAD); captured candidates quarantine in pending.
- test/markers.test.mjs (5 tests): format, quoting, parse tolerance, round-trip,
  legacy mapping. Docs: decisions.md grammar section, SKILL.md, README, CHANGELOG.
## Doctrine applied: capture mechanism repaired (2026-08-20)

Director doctrine: repair the lowest shared mechanism that owns a failure class;
improve existing primitives over wrappers/rules; new code is new failure centers.
Applied immediately:
- Recorded in the live ledger: repair-doctrine = lowest-shared-mechanism.
- Repaired: the two parallel capture functions (captureNotes + captureDecisionMarkers)
  were the same spawn/redact/catch loop for different marker kinds. Merged into one
  captureMarkers() over the unified grammar — one capture mechanism, one failure
  center. Hook calls it once per Stop.
- Removed the undocumented MAX_NOTES=3 capture cap (artificial restriction, no
  provenance); pending test updated 3 -> 5.
- extractNotes/extractDecisionMarkers remain as pure extraction primitives.
- Verified: 184/184 suite green, no dangling references.
- Audit of the session's work against the doctrine: the marker grammar module
  consolidated two implementations into one (net fewer failure centers); the revival
  guard extended decisionSet (the owner) rather than wrapping it; NOTE fold-in
  improved the existing capture primitive.
## Audits run on the session code (2026-08-20)

### CENTER-GEO (center-multigeometry scan, v0.2.0)
Target: Lodestar working tree, scoped config (44 files, 0 failures, 238 signals,
6 engines: radial 112, cycle 5, boundary 0 [no tags configured -> zero != health],
anomaly 60, convergent 37, path 24 [plugin->core]). 25 hypotheses, all critical-hinted.
Leads (NOT confirmed defects): structural risk concentrates in src/agent-state.mjs
(the dispatch/projection hub — largest import fan-out) and src/database.mjs (persistence
hub); lodestar-hook.mjs fan-out (imports the whole runtime per event); src/markers.mjs
surfaced via the new plugin->core shared edge (the intended unification). No defect
claims; suggested center-audit candidates are the two hubs.

### LADDER-AUDIT
Outcome contract: a marker written in a real agent turn is captured and appears in the
next session's startup projection.
- RUNG R1 (spawned hook executable, all marker kinds + legacy NOTE + decoy): PASS —
  3 decision events (authority=agent, session propagated), 2 pending candidates,
  [WIP] decoy ignored.
- RUNG R1b (replay): PASS — zero duplicates.
- RUNG R2 (SUPERSEDED kill via spawned hook): PASS — drop landed.
- RUNG R3 (next-session start projection): PASS — facts/blocked/dead/pending all
  projected with markers + negation sentences.
- TRANSFER PROBE: FAIL (material) — a captured SUPERSEDED marker degraded to a plain
  DEAD: by= survived only in reason prose while the projection said "It has no
  replacement" — a contradiction. Owner: decision drop model (no successor field).
  REPAIRED: drop events carry --successor; capture passes the marker's by=; replay
  carries it; rendering emits [SUPERSEDED key=... by=<successor> ...] + "Use <by>."
  Verified 185/185 + end-to-end through the spawned hook.