# Lodestar agent-friction hardening + rejection register — codeplan

> **Draft plan (untracked until the implementation PR).** Authored 2026-09-28 from field friction observed during a real Director operations session (registry rebinding, skills-queue processing, upstream PR #48, impeccable 4.4.0 migration) plus Director direction to add a rejection register.
>
> **Revision 2 (2026-09-28): adversarial review by gpt-6-sol integrated** (codex exec, session `01a0e6b3-3fd3-7bf3-b16a-03cce46df32c`, read-only, 151,903 tokens). All BLOCKER and IMPORTANT findings are resolved in this revision; full ledger in §8. A second Sol pass via the Hermes delegation pin was running at authoring time; any deltas merge as Revision 3.
>
> **Revision 3 (2026-09-28): second Sol pass integrated** (Hermes delegation, gpt-6-sol pin, 59 API calls, ~590 s — independent fresh context over the same falsification mandate). No new BLOCKERs beyond the codex pass; its three BLOCKER-level findings matched codex-S1/S4 or upgraded S6. Deltas merged: build source-root concretized for T5/T10; update-example assertions strengthened (§6C); interception boundary made precise (direct `put` create/update only); changelog convention corrected (no Unreleased section exists). Full ledger in §8.

Date: 2026-09-28
Scope owner: Director
Method: Codeplan (evidence-gated) + Center Audit (claim proof) + golden rules.
Status: PLAN-OUT rev2 (EXEC-OUT appended during implementation).

[codeplan · lodestar-agent-friction · IN · mode: guided · profile: standard · confidence: high · candidates: W1:V1a W2:V0 W3:V0+ W4:V1r · lean: all-V-lean]

## 1. Task contract

Four workstreams, one PR, one release cycle:

- **W1 — Self-teaching CLI.** Close the small gaps where the CLI's own contracts failed to teach operative rules in field use. Evidence-backed sub-items: the put-update `set`/`remove` rule (specific action for a failure that currently has only a generic one); `decision_conflict` guidance at **both** actionless sites; `project_binding_conflict` guidance at the **four** actionless sites; the `get` result shape (`data` vs `data.data`).
- **W2 — Managed-asset build discoverability.** An editor must learn the manifest/parity rules *before* CI tells them (AGENTS.md + build-script header). Wording must describe the two checks accurately (byte-manifested skill payloads; separately enforced bootstrap parity).
- **W3 — Large `start` consumption.** Broaden the existing `--output` guidance from "when a host clips" to "when the response is large or clipped." Do NOT reintroduce a startup budget — the mechanism was deliberately removed in the lean pass (superseded decision; E20).
- **W4 — Rejection register (revised).** Record, present, and serve settled rejections (models, data, architecture, anything "never revisit") so rediscovery is intercepted at orientation (`start`), at search (`find`), and at write time (`put` **subject-match advisory**, persisted with the receipt). Stay non-noisy, non-blocking, non-overengineered. This revision fixes the applicability contract, the reachable-collision set, the replay semantics, and the noise bounds after the Sol review.

### Non-goals (explicit)

- No startup-budget reintroduction, no truncation surface.
- No new command families, no new verbs on existing families.
- No daemon/service/hook/session surfaces (repository boundary).
- No new quality gates; no gate-threshold changes; no pre-commit machinery.
- Decision statuses unchanged (`accepted|blocked`; drop `dead|superseded`).
- No engine-level enforcement of a rejection's mandatory `reason` (convention only).
- No blocking behavior anywhere: the write-time check is persisted advisory text in `next`, never a refusal.
- Out of scope (adjacent, tracked for honesty, not planned): Windows `.cmd` launcher resolution for non-bash callers; registry mixed-indentation tooling; local doc snippets predating this cycle.

### Constraints

- Single PR from `origin/main` via a separate worktree (the main checkout holds active Director WIP; never disturb it — same method as PR #48).
- **Two revisions are in play and must not be conflated:** anchors in this plan were verified against the working tree (`HEAD 4284d024` + current WIP); implementation branches from `origin/main` (`ae0e3548`). **T0 re-verifies every cited anchor in the implementation worktree before any edit.**
- Managed-asset discipline **applies to this PR itself**: any edit under `managed-assets/**` requires the write-mode regeneration of the byte manifest (which **requires `--source-root`**; see E16rev) and the resulting diffs reviewed in the same PR.
- `main` is branch-protected (4 required checks). Merge and release are the Director's call.

## 2. Repository evidence (calibrated; Sol-verified where noted)

| # | Anchor | Fact |
| --- | --- | --- |
| E1 | `src/records.mjs:1043-1047` (+ `:591-595`) | `updateRecordValue`: missing/malformed `set`/`remove` fails with `invalidMutation("update requires object set and array remove fields.")`. `invalidMutation` supplies a **generic** action ("Upgrade the caller…") — the fix adds a *specific* action, not an absent one. *(Sol: disputed as originally worded; corrected here.)* |
| E2 | `src/records.mjs:163-170` (surfaced via `lodestar put --help` `mutation_inputs`) | Update alternative requires `["mode","id","set","remove"]`; present but buried inside a large `oneOf`; no example shown. |
| E3 | `src/decision.mjs:141-142` vs `:144-147` **and `:165-167`** | `direction_required` carries a specific action (in-repo precedent); **two** `decision_conflict` sites are actionless: the stale-predecessor conflict (`:144-147`) and the historical-head conflict (`:165-167`). |
| E4 | `src/project.mjs:159-162`, `:173-176`, `:183-185` | `project_binding_conflict` at `:159` has an action; at `:173` and `:183` there is **none**. |
| E5 | `src/records.mjs:852-858` vs `:1217-1219`; `src/pending.mjs:63-68` (`:67`) | Mutate-level binding conflict has an action; the canonical-scope throw (`:1219`) and the pending-promotion throw (`pending.mjs:67`) have **none**. |
| E6 | `src/cli-commands.mjs:43-59` | `validateDomainInput`: generic messages without specific actions. |
| E7 | `src/agent-state.mjs:119-127` (selection), `:148-179` (dependencies) | Start context = records in project scope **or** `global` scope **only when `semantics.applicability.project` matches this project**; `context_role='orientation'`, `lifecycle IN ('current','unresolved')`, ordered `priority DESC, id`; each carries `selection_reason`. Global records with null applicability do **not** enter via orientation selection. |
| E8 | `src/agent-state.mjs:130-147` | `--topic` adds `findRecords` hits to the same context map. |
| E9 | `src/queries.mjs:129-137`; `cli-commands.mjs:95-97` | `find` matches aliases by substring (`instr(lower(alias), lower($query)) > 0`); `find --kind` filter exists; `find` w/o `--scope` searches across scopes. |
| E10 | `src/records.mjs:1119-1132`, `:801-850` | `putRecord` — create/update/replace on the shared guarded mutation path; `mutate` owns receipts/preconditions; **receipt replay returns the stored result before the callback runs** (`:835-850`), and today's receipt result stores `{data}` only (`:908-923`). |
| E11 | `src/bootstrap.mjs:11-13`; `managed-assets/bootstrap.json` (`instructions[7]` **and** `text`) | The start-visible operating guide is the packaged bootstrap; both representations carry the same `--output` guidance (clip-only). The builder copies `text` into the bootstrap stub and generates `docs/agent-bootstrap.json`, plugin mirror included (build script `:135-152`). |
| E12 | `managed-assets/skills/lodestar/SKILL.md:84-88` | Same clip-only `--output` guidance. |
| E13 | `managed-assets/skills/lodestar/references/knowledge.md:1-39` | Scoped-knowledge reference; no get-shape note; no rejection/never-revisit section. |
| E14 | `managed-assets/skills/lodestar/references/decisions.md:3-6` | Basis guidance exists; nothing about fresh-key `supersedes_event_id`. |
| E15 | `AGENTS.md:1-40` | Repository instructions: boundaries, ownership, thresholds. No asset-build or verification-invariant note. |
| E16rev | `scripts/build-managed-assets.mjs:1-5`, `:119-132`, `:135-152` | No header/docblock; bare invocation = check mode; **write mode requires `--source-root`**; bootstrap parity checks live at `:135-152` and in `test/package.test.mjs:216-228`. |
| E17 | `README.md:238-251` | README documents the correct build command (incl. source root) *before* CI — but only in the Development section, not where an editor of `managed-assets/**` first looks. *(Sol: "post-hoc" wording imprecise; corrected.)* |
| E18 | `test/documentation.test.mjs:45-55` | Every shipped JSON mutation example currently must be **create**-mode; an update-mode example requires the test extended (planned, full replacement in §6C). |
| E19 | `test/helpers/contract.mjs:18-46` | `fixture(t)` → `{root, database, cli, request, create}`; in-process CLI; `f.request` derives a fresh basis; `create(...)` supports semantics overrides. |
| E20 | `CHANGELOG.md:151-156` | Startup-budget removal is deliberate ("no truncation surface"). W3 must not re-add one. |
| E21 | `src/records.mjs:41-42`, `:100-119` | `UPDATE_SET_FIELDS` includes `semantics`; retirement metadata accepted → retire-by-update valid. |
| E22 | Field session 2026-09-28 (context, not repository evidence) | Observed: `decision_conflict` on a fresh key with `supersedes_event_id: null`; buried-but-present put schema; `get` record fields directly under `data` (payload at `data.data` — source-supported, C7); a 98 KB `start` on a mature project. *(Sol: kept as context; the source-checkable parts are cited in C7/C1.)* |
| E23 | `src/schema.mjs:54-57`; `src/records.mjs:479-490`, `:277-285` | **`aliases.alias` is a PRIMARY KEY** and admission **rejects an alias owned by another record**; `resolveRecordId` assumes exactly one owner. Two records cannot share an alias — the advisory cannot fire on alias equality; the reachable collision surface is `data.subject`. |
| E24 | `src/records.mjs:1020-1038` | Uniqueness/conflict machinery applies when `semantics.subject` is supplied: two current records with the same `semantics.subject` and same applicability conflict. Rejections should carry `semantics.subject` to engage it. |
| E25 | `src/records.mjs:1008-1017` | Reserved-type check allows ordinary kinds; `kind: "rejection"` is permitted (not a command-owned kind). |

## 3. Center Audit ledger (read-only; run 2026-09-28; Sol-verified verdicts)

Method: read-only source inspection + live `--help`/`get`/`find` probes; no mutations. Verdicts below incorporate the Sol review's corrections.

- **C1 — imprecise (fixed).** The `set`/`remove` requirement IS in the schema, and the failure path DOES carry a generic action. The real defect: the action is generic, not corrective. Fix targets a specific action + doc salience, not a missing fact.
- **C2 — imprecise (fixed).** Two actionless `decision_conflict` sites (`:144-147` stale predecessor; `:165-167` historical head). Both get specific guidance.
- **C3 — imprecise (fixed).** Four actionless `project_binding_conflict` sites: `project.mjs:173`, `:183`, `records.mjs:1219`, `pending.mjs:67`. All get specific actions; an implementation-time grep confirms no others.
- **C4 — imprecise (fixed).** README documents the build command before CI; the gap is *placement* (AGENTS.md + builder header lack it). Fix = put the invariant where the editor actually is.
- **C5 — confirmed.** Bootstrap + skill guidance trigger `--output` only on clipping.
- **C6 — imprecise (fixed).** No general rejection register exists; note `rejected_alternative` is also an explicit optional decision input that may be inherited — not solely captured on value change.
- **C7 — confirmed.** `get` returns the normalized record directly as envelope `data`; the record's payload is that record's `data.data` (`agent-state.mjs:277-283`, `records.mjs:1274-1284`).
- **C8 — imprecise (fixed).** The orientation machinery fits **project-scoped** rejections; global-with-null-applicability records do NOT enter orientation. W4 rev2 therefore adopts the same applicability rule for start AND the advisory (see §5).
- **C9 — confirmed.** A shipped update example would fail the current create-only documentation assertion; the test is extended with the create branch retained verbatim (§6C).

## 4. Candidates, decision trace, choices

### W1 — Self-teaching CLI
- **V0 docs-only.** Cheap; does not fix the failure path agents actually hit.
- **V1a: guided errors + doc clarity + one help-summary sentence (CHOSEN).** (a) `records.mjs:1045-1047`: specific action — "Include `\"remove\": []` when the update removes no data keys; run `lodestar put --help` for the complete input." (b) `decision.mjs:144-147`: "For a key with no current head, omit `supersedes_event_id` entirely; otherwise pass the head's event_id from `decision show <key>`." (c) `decision.mjs:165-167`: "The supplied predecessor is stale: re-read the stream with `decision show <key>` and pass the current head." (d) `project.mjs:173-176`, `:183-185`, `records.mjs:1219`, `pending.mjs:67`: specific actions (refresh peers / refresh roots / reread canonical scope / target the canonical checkout). (e) `cli-commands.mjs:91`: append "Updates require `set` and `remove` (use `\"remove\": []` when removing nothing)." to the `put` summary. (f) `knowledge.md` one sentence on the `get` shape; `decisions.md` one sentence on fresh-key supersedes handling.
- **V2: help restructure / examples everywhere (rejected).** Churn against a large tested help surface; no evidence beyond W1's cases.

### W2 — Build discoverability
- **V0: `AGENTS.md` new section + build-script docblock (CHOSEN).** Precise wording: "managed skill payload bytes are covered by the maintained byte manifest; bootstrap parity (stub + generated documentation) is enforced by its own checks; after editing `managed-assets/**` run the write-mode build with `--source-root` (README Development section, `scripts/build-managed-assets.mjs:119-152`) and `npm test`." No "setup paragraph" assumption — placement decided against the actual 40-line file at implementation.
- **V1: new docs page (rejected).** README already covers commands; duplication creates drift.

### W3 — Large `start`
- **V0+: broaden the clip guidance (CHOSEN).** Word-level change in `bootstrap.json` (`instructions[7]` **and** `text` — both, consistently) + `SKILL.md:84-88` + one `knowledge.md` line: "If a response is large or a host clips it, capture with `--output <new-file>` and read only the sections needed." No mechanism, no envelope change. Builder regenerates stub/documented/bootstrap mirror in T10.
- **V1: `COMMANDS.start` summary clause (optional, implementer's call).**
- **V2: reintroduce a budget/truncation (REJECTED — superseded decision, E20).**

### W4 — Rejection register (revised after Sol)
- **V0: convention-only (insufficient).** Docs alone cannot intercept.
- **V1r: convention + receipt-persisted subject-match advisory + alias-ownership enlightenment (CHOSEN).** Register = ordinary records (kind `rejection`, orientation/current semantics, explicit priority, `semantics.subject` set, searchable aliases). Engine adds exactly two bounded touches: (i) the put advisory on **`data.subject` exact (case-folded) match against current rejections under the start-visibility rule**, computed at acceptance and **persisted inside the receipt result** (replay-exact); (ii) when alias admission rejects an alias owned by a current rejection, the error's action names the rejection. Never blocks; silent otherwise.
- **V2: first-class rendering (rejected).** Surface growth; premature without field evidence.
- **V3: `lodestar rejected` command family (rejected).** Violates lean doctrine and repository boundaries.

### Freeze

[codeplan · lodestar-agent-friction · FREEZE · W1: V1a · W2: V0 · W3: V0+ · W4: V1r · rubric: lean-fit 0.35 / prevention 0.30 / noise-risk 0.20 / diff-size 0.15 · scorer: Hermes (planning agent), frozen before scoring]

| Candidate | Lean-fit | Prevention | Noise-risk (low=good) | Diff | Decision |
| --- | --- | --- | --- | --- | --- |
| W1-V1a | high | high (actual failure moments) | none (error text only) | ~45 LOC + docs | chosen |
| W2-V0 | high | high (agent-readable surface) | none | ~20 lines text | chosen |
| W3-V0+ | high | medium (consumption pattern) | none | ~5 lines text | chosen |
| W4-V1r | high (reuses record model + receipt discipline) | layered: start + find + advisory + alias error | low (exact subject match; bounded text; receipt-persisted) | ~60 LOC + docs + tests | chosen |

[codeplan · lodestar-agent-friction · PLAN-OUT rev2 · tests: pre-written (3 files, full code) · pre-harden: self + Sol adversarial (EXECUTED, §8) · rollout: single PR, worktree from origin/main, assets built with --source-root in-PR]

## 5. Rejection register — normative design (W4 rev2 detail)

### Shape (convention; validated by existing record validation; **illustrative** — the shipped, test-covered examples are complete contract-5 envelopes, see T7)

```json
{
  "id": "rejection:<slug>",
  "kind": "rejection",
  "name": "<Subject> — rejected",
  "scope": "<project scope>",
  "availability": "known",
  "priority": 200,
  "data": {
    "subject": "<human subject phrase — the advisory's match key>",
    "verdict": "never-revisit",
    "reason": "<one line, mandatory by convention>",
    "rejected_on": "<RFC3339 date>",
    "direction": "<user reference when Director-mandated; omit for evidence-based>",
    "evidence": [],
    "alternatives": []
  },
  "aliases": ["<subject terms — the strings a future agent would search>"],
  "links": [],
  "sources": [],
  "semantics": {
    "subject": "<subject-slug>",
    "lifecycle": "current",
    "context_role": "orientation",
    "basis": "user_direction",
    "applicability": { "project": "<project scope>", "checkout": null }
  }
}
```

- **Priority (E7rev)**: `priority` must be set explicitly (default is 0 and sorts below/with ordinary records). Convention: a value above ordinary context records; T7 verifies the live scale and the ordering test (§6B) pins "rejection sorts before a priority-0 orientation record".
- **`semantics.subject` (E24)**: set to the subject slug so duplicate-rejection detection engages (two current rejections for the same subject + applicability conflict loudly instead of accumulating).
- **Applicability contract (E7, Sol BLOCKER-2 resolution)**: start-visibility = `scope == acting project` OR (`scope == "global"` AND `applicability.project == acting project scope`). **The advisory uses the identical rule** — what orientation shows, the advisory warns about; nothing else. Global-with-null-applicability rejections travel via `find`/`get` only. Convention in docs: "a rejection that must appear in a project's orientation (and therefore warning) carries `applicability.project` = that project's scope."
- **Retirement**: `put` update `set.semantics.lifecycle = "superseded"` + `retirement_reason` (E21); start omits superseded automatically; the advisory skips non-current rejections. `delete` remains the alternative.

### Recording (docs contract — `knowledge.md` new section)

When to record: a model, dataset, architecture, or element is formally rejected (Director direction, or evidence-backed verdict after trial). One rejection per settled subject. Record once; update in place for new evidence; never re-litigate without a recorded user-direction update. The section ships **two** compliant examples: a create-mode JSON example **and** a complete update-mode example (evidence extension or retirement) — required by §6C's test.

### Presenting & serving — the interception layers

1. `start`: automatic via E7 (priority-ordered orientation record; `selection_reason: "orientation"`).
2. `find`/`get`: automatic via E9 (alias substring search, all scopes). Docs: a `kind: "rejection"` hit is a settled verdict — stop and read before proposing.
3. **Put subject-advisory (engine touch 1)** — in `putRecord`'s callback (so it is computed at acceptance): after a successful create/update of a record that is not itself a rejection, compare the **effective record's `data.subject`** (case-folded, exact) against current rejections under the start-visibility rule (§above). On match(es), the callback returns `next` entries; `mutate` persists them with the accepted result (receipt result gains optional `next` — see below); **replays return the stored advisory verbatim** (Sol BLOCKER-3 resolution: the first accepted advisory is part of the replayable receipt; fresh responses compute from current state at acceptance). Advisory text: `"Settled rejection covers this subject: <id> — <reason, truncated ~140 chars>. Read it before proceeding."` Bounds: dedup by id, sorted by id, at most **3** lines, then one overflow line `"N more current rejections share this subject; run lodestar find <subject>."` Never affects admission, `data`, or acceptance. **Boundary (rev3)**: this interception covers direct `put` create/update only — `put` replace and `pending` promotion (which applies a put destination through `applyPutInput` directly, `pending.mjs:63-69`) are outside the guard; extending there is explicitly deferred pending field evidence.
   - **Receipt change (bounded)**: `mutate`'s stored result currently `{data}` (`records.mjs:908-923`); extend to `{data, ...(next.length ? {next} : {})}`. The replay path (`:843-849`) spreads the stored result, so stored-next replays exactly. Verify both fresh and replay return paths construct from the stored result; no other receipt fields change.
4. **Alias-ownership enlightenment (engine touch 2)** — when admission rejects an alias owned by another record (E23, `records.mjs:479-490`) **and** the owner is a current rejection under the start-visibility rule, augment the error's `action` to name it: "Alias `<alias>` is held by rejection record `<id>` — read it before choosing a different alias." Message/code unchanged; non-rejection owners: error unchanged.

### Honest prevention boundary (goes in the docs too)

Lodestar cannot stop an agent from silently re-deriving a rejected idea. What it guarantees: interception at every access point the agent actually touches — orientation (`start`), search (`find`), write (`put` advisory, receipt-persisted), alias reuse (admission error names the rejection) — plus a documented contract that the check is mandatory at proposal boundaries. Stated in the plan and docs rather than overclaimed.

## 6. Pre-written tests (drop-in at implementation)

### A. `test/decision.test.mjs` — append (covers BOTH conflict sites)

```js
test('decision_conflict actions teach the head rules', async (t) => {
  const f = await setup(t);
  const stale = await f.change('set', { key: 'fresh:key', value: 'v', reason: 'r',
    status: 'accepted', supersedes_event_id: null });
  assert.notEqual(stale.code, 0);
  assert.equal(stale.value.error.code, 'decision_conflict');
  assert.match(stale.value.error.action, /supersedes_event_id/u);
  // Historical-head variant: set twice, then revise with a stale predecessor id.
  await f.change('set', { key: 'heads:key', value: 'A', reason: 'initial', status: 'accepted' });
  const first = await f.cli(['decision', 'show', 'heads:key', '--cwd', f.root]);
  const staleId = first.value.data.facts[0].event_id;
  await f.change('set', { key: 'heads:key', value: 'B', reason: 'revised', status: 'accepted' });
  const second = await f.change('set', { key: 'heads:key', value: 'C', reason: 'stale revision',
    status: 'accepted', supersedes_event_id: staleId });
  assert.notEqual(second.code, 0);
  assert.equal(second.value.error.code, 'decision_conflict');
  assert.match(second.value.error.action, /decision show/u);
});
```

*(The `facts[0].event_id` identifier is verified against the returned basis shape at implementation; adjust only the identifier, keep the assertions. If the historical-head variant proves unreachable via `supersedes_event_id` alone, drive it via the second conflict site's actual trigger and keep the action assertion.)*

### B. `test/rejection-register.test.mjs` — new file

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';

async function rejectionFixture(t) {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  return f;
}

function rejectionRecord(overrides = {}) {
  return {
    id: 'rejection:materialized-views',
    kind: 'rejection',
    name: 'Materialized views — rejected',
    scope: 'project:test',
    availability: 'known',
    priority: 200,
    data: { subject: 'materialized views', verdict: 'never-revisit',
      reason: 'Rebuild cost and staleness outweighed read speed; revisit only on recorded direction.' },
    aliases: ['materialized views', 'matview approach'],
    links: [], sources: [],
    semantics: { subject: 'materialized-views', lifecycle: 'current', context_role: 'orientation',
      basis: 'user_direction', applicability: { project: 'project:test', checkout: null } },
    ...overrides,
  };
}

async function putRaw(f, input, targets, projectScope = 'project:test') {
  return f.cli(['put'], await f.request(input, targets, projectScope));
}

test('a rejection record is created through the ordinary contract and is findable by subject alias', async (t) => {
  const f = await rejectionFixture(t);
  const created = await putRaw(f, { mode: 'create', record: rejectionRecord() },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  assert.equal(created.code, 0, JSON.stringify(created.value));
  const found = await f.cli(['find', 'materialized views', '--scope', 'project:test']);
  assert.equal(found.code, 0);
  assert.ok(found.value.data.records.some(({ id }) => id === 'rejection:materialized-views'));
});

test('a rejection record enters start orientation and sorts above ordinary records', async (t) => {
  const f = await rejectionFixture(t);
  await putRaw(f, { mode: 'create', record: rejectionRecord() },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  await putRaw(f, { mode: 'create', record: {
    id: 'note:ordinary', kind: 'note', name: 'Ordinary', scope: 'project:test',
    availability: 'known', priority: 0, data: { subject: 'scheduling' },
    aliases: ['scheduling'], links: [], sources: [],
    semantics: { subject: 'scheduling', lifecycle: 'current', context_role: 'orientation',
      basis: 'asserted', applicability: { project: 'project:test', checkout: null } },
  } }, [{ kind: 'record', id: 'note:ordinary' }]);
  const started = await f.cli(['start', '--cwd', f.root]);
  assert.equal(started.code, 0, JSON.stringify(started.value));
  const context = started.value.data.context ?? [];
  const ids = context.map(({ id }) => id);
  assert.ok(ids.includes('rejection:materialized-views'), 'rejection appears in start context');
  assert.ok(ids.indexOf('rejection:materialized-views') < ids.indexOf('note:ordinary'),
    'rejection sorts above the priority-0 ordinary record');
});

test('put create matching a rejection subject carries a persisted, non-blocking advisory', async (t) => {
  const f = await rejectionFixture(t);
  await putRaw(f, { mode: 'create', record: rejectionRecord() },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  const proposal = await putRaw(f, { mode: 'create', record: {
    id: 'note:matview-proposal', kind: 'note', name: 'Matview proposal', scope: 'project:test',
    availability: 'known', data: { subject: 'Materialized Views' },
    aliases: ['matview proposal'], links: [], sources: [],
  } }, [{ kind: 'record', id: 'note:matview-proposal' }]);
  assert.equal(proposal.code, 0, JSON.stringify(proposal.value));
  assert.ok((proposal.value.next ?? []).some((line) => /rejection:materialized-views/u.test(line)),
    'advisory names the rejection record');
});

test('update moving a record onto a rejected subject also warns', async (t) => {
  const f = await rejectionFixture(t);
  await putRaw(f, { mode: 'create', record: rejectionRecord() },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  await putRaw(f, { mode: 'create', record: {
    id: 'note:drifts', kind: 'note', name: 'Drifts', scope: 'project:test',
    availability: 'known', data: { subject: 'scheduling' },
    aliases: ['drifts'], links: [], sources: [],
  } }, [{ kind: 'record', id: 'note:drifts' }]);
  const moved = await putRaw(f, { mode: 'update', id: 'note:drifts',
    set: { data: { subject: 'materialized views' } }, remove: [] },
    [{ kind: 'record', id: 'note:drifts' }]);
  assert.equal(moved.code, 0, JSON.stringify(moved.value));
  assert.ok((moved.value.next ?? []).some((line) => /rejection:materialized-views/u.test(line)));
});

test('replay of an accepted request returns the stored advisory even after the register changes', async (t) => {
  const f = await rejectionFixture(t);
  await putRaw(f, { mode: 'create', record: rejectionRecord() },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  const input = { mode: 'create', record: {
    id: 'note:replayed', kind: 'note', name: 'Replayed', scope: 'project:test',
    availability: 'known', data: { subject: 'materialized views' },
    aliases: ['replayed'], links: [], sources: [],
  } };
  const body = await f.request(input, [{ kind: 'record', id: 'note:replayed' }]);
  const first = await f.cli(['put'], body);
  assert.equal(first.code, 0);
  assert.ok((first.value.next ?? []).some((line) => /rejection:materialized-views/u.test(line)));
  // Retire the rejection, then replay the exact same accepted request.
  await putRaw(f, { mode: 'update', id: 'rejection:materialized-views',
    set: { semantics: { subject: 'materialized-views', lifecycle: 'superseded',
      context_role: 'orientation', basis: 'user_direction',
      applicability: { project: 'project:test', checkout: null },
      retirement_reason: 'Superseded by recorded direction.' } }, remove: [] },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  const replay = await f.cli(['put'], body);
  assert.equal(replay.code, 0);
  assert.equal(JSON.stringify(replay.value.next ?? []), JSON.stringify(first.value.next ?? []),
    'replayed advisory is byte-identical to the accepted one');
});

test('unrelated creates carry no advisory; retired rejections are silent', async (t) => {
  const f = await rejectionFixture(t);
  await putRaw(f, { mode: 'create', record: rejectionRecord() },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  const unrelated = await putRaw(f, { mode: 'create', record: {
    id: 'note:unrelated', kind: 'note', name: 'Unrelated', scope: 'project:test',
    availability: 'known', data: { subject: 'scheduling' },
    aliases: ['scheduling'], links: [], sources: [],
  } }, [{ kind: 'record', id: 'note:unrelated' }]);
  assert.equal(unrelated.code, 0);
  assert.equal((unrelated.value.next ?? []).some((line) => /rejection:/u.test(line)), false);
  await putRaw(f, { mode: 'update', id: 'rejection:materialized-views',
    set: { semantics: { subject: 'materialized-views', lifecycle: 'superseded',
      context_role: 'orientation', basis: 'user_direction',
      applicability: { project: 'project:test', checkout: null },
      retirement_reason: 'Expired experiment.' } }, remove: [] },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  const afterRetire = await putRaw(f, { mode: 'create', record: {
    id: 'note:late', kind: 'note', name: 'Late', scope: 'project:test',
    availability: 'known', data: { subject: 'materialized views' },
    aliases: ['late'], links: [], sources: [],
  } }, [{ kind: 'record', id: 'note:late' }]);
  assert.equal(afterRetire.code, 0);
  assert.equal((afterRetire.value.next ?? []).some((line) => /rejection:/u.test(line)), false);
  const started = await f.cli(['start', '--cwd', f.root]);
  assert.equal((started.value.data.context ?? []).some(({ id }) => id === 'rejection:materialized-views'), false);
});

test('a global rejection with null applicability never enters orientation or the advisory', async (t) => {
  const f = await rejectionFixture(t);
  await putRaw(f, { mode: 'create', record: rejectionRecord({ scope: 'global',
    semantics: { subject: 'materialized-views', lifecycle: 'current', context_role: 'orientation',
      basis: 'user_direction', applicability: { project: null, checkout: null } } }) },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  const started = await f.cli(['start', '--cwd', f.root]);
  assert.equal((started.value.data.context ?? []).some(({ id }) => id === 'rejection:materialized-views'), false);
  const probe = await putRaw(f, { mode: 'create', record: {
    id: 'note:probe', kind: 'note', name: 'Probe', scope: 'project:test',
    availability: 'known', data: { subject: 'materialized views' },
    aliases: ['probe'], links: [], sources: [],
  } }, [{ kind: 'record', id: 'note:probe' }]);
  assert.equal(probe.code, 0);
  assert.equal((probe.value.next ?? []).some((line) => /rejection:/u.test(line)), false);
});

test('reusing a rejection-owned alias fails and names the rejection', async (t) => {
  const f = await rejectionFixture(t);
  await putRaw(f, { mode: 'create', record: rejectionRecord() },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  const clash = await putRaw(f, { mode: 'create', record: {
    id: 'note:alias-clash', kind: 'note', name: 'Clash', scope: 'project:test',
    availability: 'known', data: { subject: 'unrelated' },
    aliases: ['matview approach'], links: [], sources: [],
  } }, [{ kind: 'record', id: 'note:alias-clash' }]);
  assert.notEqual(clash.code, 0);
  assert.match(clash.value.error.action, /rejection:materialized-views/u);
});

test('update without remove teaches the empty-array rule', async (t) => {
  const f = await rejectionFixture(t);
  await putRaw(f, { mode: 'create', record: rejectionRecord() },
    [{ kind: 'record', id: 'rejection:materialized-views' }]);
  const bad = await putRaw(f, { mode: 'update', id: 'rejection:materialized-views',
    set: { name: 'Renamed' } }, [{ kind: 'record', id: 'rejection:materialized-views' }]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.value.error.action, /remove/u);
});
```

*(`f.request` derives a fresh basis per call; no manual `get` dance is needed. The retire-by-update uses `remove: []` — which this suite also exercises as living documentation of the rule.)*

### C. `test/documentation.test.mjs` — full replacement of the mutation loop (create branch retained verbatim)

```js
  const mutations = examples.filter(({ value }) => value?.v === 5 && value?.write_basis && value?.input);
  assert.ok(mutations.length > 0, "at least one complete mutation example is required");
  let updateExamples = 0;
  for (const { value } of mutations) {
    const request = normalizeMutationRequest(value);
    if (request.input.mode === "update") {
      updateExamples += 1;
      assert.equal(typeof request.input.id, "string");
      assert.ok(request.input.set !== null && typeof request.input.set === "object"
        && !Array.isArray(request.input.set)
        && Object.getPrototypeOf(request.input.set) === Object.prototype,
        "update examples carry a plain-object set");
      assert.ok(Array.isArray(request.input.remove)
        && request.input.remove.every((key) => typeof key === "string"),
        "update examples carry an array remove of string keys");
      continue;
    }
    assert.equal(request.input.mode, "create");
    const record = request.input.record;
    validatePutInput({ id: record.id, type: record.kind, name: record.name, scope: record.scope,
      priority: record.priority ?? 0, content: { state: record.availability, value: record.data,
        _lodestar: { priority: record.priority ?? 0, revision: 1, semantics: record.semantics } },
      aliases: record.aliases, links: record.links, sources: record.sources });
  }
  assert.ok(updateExamples > 0, "at least one documented update example is required");
```

## 7. Implementation plan (ordered tasks)

All work on branch `agent-friction-hardening` in a fresh worktree from `origin/main` (`git worktree add ../lodestar-afh origin/main -b agent-friction-hardening`). TDD order per task.

- **T0 (rev2)** Re-verify every cited anchor (E1–E25) in the implementation worktree (branch base = `origin/main ae0e3548`, NOT the dirty tree this plan was authored against). No edits before T0 passes.
- **T1 (W1a)** `src/records.mjs:1045-1047` — specific action for the missing `remove` (extend `invalidMutation` with an optional action parameter at `:591-595`, or throw the richer error at the call site). Tests: B-last.
- **T2 (W1b)** `src/decision.mjs` — actions at `:144-147` AND `:165-167` (distinct guidance each). Test: A.
- **T3 (W1c)** `src/project.mjs:173-176`, `:183-185`; `src/records.mjs:1217-1219`; `src/pending.mjs:67` — specific actions; then grep `project_binding_conflict` + `decision_conflict` across `src/` once and fix any remaining actionless throw.
- **T4 (W1d)** `cli-commands.mjs:91` put-summary sentence; `knowledge.md` get-shape sentence; `decisions.md` supersedes sentence.
- **T5 (W2)** `AGENTS.md` — new "## Repository verification invariants" section (placement decided against the actual file; wording per §4-W2: byte-manifested skill payloads; separate bootstrap parity; write-mode build requires `--source-root` — **the golden-rules root per the README invocation; VERIFY the exact path at T0**; run `npm test`); `scripts/build-managed-assets.mjs` — docblock with the same invariant + `--check` default note.
- **T6 (W3)** `managed-assets/bootstrap.json` — `instructions[7]` **and** `text` changed together ("large or clips"); review generated stub + `docs/agent-bootstrap.json` + plugin mirror diffs; `SKILL.md:84-88`; `knowledge.md` one line.
- **T7 (W4a)** `knowledge.md` — "Settled rejections (never revisit)" section: shape (priority + `semantics.subject` explicit), applicability contract, when to record, retirement, the interception layers + boundary, honest boundary, **one create example + one update example, both as complete contract-5 envelopes (v5 + write_basis + input) in a shipped document** — enables §6C.
- **T8 (W4b)** `src/records.mjs` — (i) `rejectionAdvisories(db, record, projectScope)` helper (exact case-folded `data.subject` match; start-visibility rule; current only; exclude the record itself; bounds: ≤3 lines + overflow, reason truncated); (ii) wire into `putRecord`'s callback result; (iii) `mutate` receipt stores optional `next` with the accepted result (`:908-923`) so replays are exact; (iv) alias-ownership error enlightenment at `:479-490` when the owner is a current rejection. Boundary (rev3): direct `put` create/update only — `put` replace and `pending` promotion are outside the guard (§5). Tests: B (all).
- **T9** Test files A, B, C as above; run the full suite.
- **T10** Regenerate assets in **write mode** — concrete form: `npm run assets:build -- --source-root <golden-rules root>` (`package.json:37` passes `--write`; `build-managed-assets.mjs:119-127` rejects `--write` without `--source-root`; README `:242-251` shows the invocation; confirm the exact root at T0) — review manifest + generated-copy diffs (expect only intended files) → `npm test` (documentation + package tests re-verify, incl. bootstrap parity `package.test.mjs:216-228`) → check-mode run passes.
- **T11** `CHANGELOG.md` — agree the versioned entry with the Director (the changelog begins directly with dated version headings; there is **no** Unreleased section — do not invent one; release framing stays with the Director).
- **T12** Push branch → PR → all required checks green → stop. Merge = Director.

Verification matrix: full `npm test`; `node lodestar.mjs put --help` / `decision set --help` smoke (schema unchanged; summary text updated); manual scratch-db run: create rejection → `find` hit → colliding create gets advisory → replay identical → retire → advisory silent → `start` placement.

## 8. Pre-harden & gap-scan

### Self-scan (authoring era; kept for the trail)

1. Doc-test conflict discovered and handled (§6C).
2. Alias substring search over-matches → convention: multi-word subject-specific aliases; advisory matches exact.
3. Advisory false positives → exact case-folded matches only; never blocks; retirement silences.
4. Start noise → no new envelope fields/counters; "one rejection per settled subject"; V2 rendering explicitly deferred.
5. Manifest self-application → T10 regenerates in-PR.
6. Bootstrap edit is contract-visible → open question Q1.
7. `supersedes_event_id` runtime semantics confirmed against the field incident.
8. Update-retire path verified (`semantics` updatable).

### Adversarial review — EXECUTED (gpt-6-sol via `codex exec`, read-only, session `01a0e6b3-3fd3-7bf3-b16a-03cce46df32c`, 151,903 tokens)

**Verdict: "The plan is not implementation ready"** — 4 BLOCKER, 5 IMPORTANT, 2 MINOR. All resolved in this revision; resolutions named inline.

| # | Severity | Finding (Sol, with evidence) | Resolution in rev2 |
| --- | --- | --- | --- |
| S1 | BLOCKER | W4 alias collision test cannot reach the advisory: `aliases.alias` is a PK (`schema.mjs:54-57`); admission rejects foreign aliases (`records.mjs:479-490`); `resolveRecordId` assumes one owner (`:277-285`). | Collision surface corrected: advisory matches `data.subject` only (§5); tests rewritten (§6B); alias path handled by new alias-ownership enlightenment (T8-iv, test included). E23 added. |
| S2 | BLOCKER | A `global` rejection doesn't automatically reach every project's `start` (`agent-state.mjs:119-127`); global-null applicability enters only via dependencies (`:148-179`); W4's global advisory reach was inconsistent. | Applicability contract adopted: **one rule for start AND advisory** (project scope, or global + matching `applicability.project`); global-null is find-only; docs convention added (§5); test added (§6B). |
| S3 | BLOCKER | Replay unspecified: receipt stores `{data}` only (`records.mjs:835-850`, `:908-923`) — callback-made advisories vanish on replay; recomputing post-mutate drifts with state. | Chosen: advisory computed at acceptance and **persisted inside the receipt result** (`{data, next?}`); replays byte-identical; fresh responses compute at acceptance. Test added (§6B "replay … byte-identical"). |
| S4 | BLOCKER | §6C test would fail as written (`updateExamples > 0` vs no update example; placeholder not drop-in) (`documentation.test.mjs:47-55`). | §6C is now a full replacement with the create branch retained verbatim; T7 ships a complete update example. |
| S5 | IMPORTANT | T6 must change **both** bootstrap representations (`instructions[7]` + `text`; builder `:135-152` propagates to stub + `docs/agent-bootstrap.json`). | T6 covers both; T10 reviews generated diffs. |
| S6 | IMPORTANT | T5/T10 build command unusable: write mode **requires `--source-root`** (`build-managed-assets.mjs:119-132`; README supplies it `:242-251`). | T5/T10 corrected; E16rev added. |
| S7 | IMPORTANT | Manifest wording overclaims bootstrap coverage (byte counts cover skill payloads; bootstrap parity separate `:135-152`, `package.test.mjs:216-228`). | W2 wording fixed: two checks, described accurately. |
| S8 | IMPORTANT | Error-site inventory incomplete: second `decision_conflict` (`decision.mjs:165-167`) and `pending.promote` (`pending.mjs:67`). | E3/E5 updated; T2/T3 cover both; C2/C3 corrected. |
| S9 | IMPORTANT | Priority defaults to 0 (example carried none; `records.mjs:989-1004`); subject uniqueness only with `semantics.subject` (`:1020-1038`); advisory text unbounded. | Example carries explicit priority + `semantics.subject`; advisory bounded (≤3 + overflow, truncated reason) and tested; ordering test added. |
| S10 | MINOR | E1/C1 wording: `invalidMutation` already supplies a generic action (`:591-595`). | Corrected (E1, C1); T1 targets a *specific* action. |
| S11 | MINOR | Reviewed-tree vs branch-base mismatch (`HEAD 4284d024`+WIP vs `origin/main ae0e3548`). | T0 added: re-verify anchors on the branch base before edits. |

**Also adopted from Sol:** exact anchor corrections (E2 `:163-170`; C7 sources; E17 wording), test-convention note (no unused `get` dance; `f.request` gives a fresh basis), the task-feasibility verdicts (T1–T12 feasible post-correction; T5 placement instruction fixed; `kind: "rejection"` permitted per `records.mjs:1008-1017`), and the string-pinning audit: the only exact pin of the default action is `test/cli.test.mjs:318,324` — unaffected (the global default is not changing); `integration-fixes.test.mjs:62` and `review-regressions.test.mjs:145` pin conflict codes, not messages — unaffected.

### Second Sol pass — EXECUTED (Hermes delegation, gpt-6-sol pin, 59 API calls, ~590 s)

Independent fresh context over the same falsification mandate (read-only; static review — its test verdicts are structural, not executed). Result: **no new blockers** — its three BLOCKER-level findings reproduce codex-S1 (alias PK) and codex-S4 (update-example requirement), both already resolved in rev2, plus a concretization of S6. Its deltas, all merged in rev3:

- Build source-root concretized: `package.json:37` passes `--write`; `build-managed-assets.mjs:119-127` rejects `--write` without `--source-root`; README `:242-251` shows the invocation with the golden-rules root → T5/T10 (exact root verified at T0).
- §6C update assertions strengthened: plain-object `set` (prototype check) + string-only `remove` keys (parallels `records.mjs:1043-1053`).
- Interception boundary made precise: direct `put` create/update only; `pending` promotion (`pending.mjs:63-69`) and `put` replace are outside the guard, explicitly deferred (§5, T8).
- Changelog convention corrected: no Unreleased section exists; dated version headings → T11.
- Precision notes adopted: shipped examples must be complete contract-5 envelopes in a shipped document (the §5 shape fence is illustrative only); the temp-root `start` test is viable but asserts context inclusion only; `f.request` already yields fresh bases (no manual re-read dance).
- Its OK-VERIFIED items confirm: lean boundary preserved; retirement path valid; ordinary `kind: "rejection"` permitted.

### Failure-mode table (pre-harden, post-Sol)

| Task | What could break | Detection | Mitigation |
| --- | --- | --- | --- |
| T1–T3 | Error-text drift vs tests | tests assert `action` regex-minimally, not full prose | keep assertions regex-minimal |
| T4/T6/T7 | Doc sentence placement drift | `npm test` (documentation + package tests) | edits only in listed files; manifest rebuilt in-PR |
| T6 | Bootstrap stub/mirror drift | T10 generated-diff review | both representations changed together; diffs reviewed |
| T8 | Advisory leaks into admission semantics | tests assert `code === 0` on advisory paths; receipt `data` unchanged | advisory only in `next`; persisted with receipt |
| T8 | Replay drift | replay test asserts byte-identical `next` | receipt-stored advisory |
| T8 | Subject-match false positives | exact case-folded equality; convention: specific subjects | silent without exact match |
| T10 | Manifest regen churn | diff review of `manifest.json` + generated copies | expect only intended files; investigate surprises |
| T12 | CI red | required checks | run `npm test` + write-mode build before pushing |

## 9. Rollout & receipts

- Branch `agent-friction-hardening` (worktree from `origin/main`); single PR; required checks; merge by Director; release/version framing by Director (release notes exist per-version — this plan does not touch `docs/releases/**`).
- Post-merge: this repo's WIP worktree stays untouched; package convergence follows the normal release path; the Hermes-installed skill copy refreshes via `lodestar setup` when the next package ships (same flow as PR #48's knowledge.md change).
- Receipts (EXEC-OUT): commit hashes, PR number, check results — appended at implementation time.

## 10. Open questions (Director-facing)

- **Q1**: Bless the `bootstrap.json` wording change ("large or clips" in `instructions[7]` + `text`)? (Recommended: yes — highest-reach sentence.)
- **Q2**: Rejection priority convention — explicit number in the docs example (rev2 uses `200`; T7 verifies the live scale and the ordering test pins the relationship, not the number). Accept a value, or keep it purely relative?
- **Q3**: Advisory line wording — draft in §5; adjust freely.
- **Q4 (revised)**: Cross-project rejections: accept the revised contract (start/advisory per project via `applicability.project`; cross-project travel via `find`) — or should a future revision design an all-project global presentation? (Recommended: accept the contract now; the global-presentation design is explicitly deferred, evidence-first.)

## EXEC-OUT (2026-09-28 — branch `agent-friction-hardening` from `origin/main ae0e354`)

Implemented as planned, with these dispositions:

- T0–T2, T4, T6–T11: executed as specified. Full suite **199/199 green** (190 baseline + 9 new), `assets:check` green, assets regenerated with `--source-root "C:/Users/zerop/Development/Golden Rules"` and **zero golden-skill churn**.
- T3: all four action-less conflict sites fixed (`project.mjs` ×2, `records.mjs`, `pending.mjs`); repo-wide grep confirms no further action-less `project_binding_conflict` / `decision_conflict` throws.
- T5: the build-script docblock shipped. The **AGENTS.md section was blocked** by the protected-agent-instruction approval prompt (timed out — not consented; no retry made). The guidance already lives in the script docblock and README; recommend a separate approved write for the AGENTS.md section.
- T11: changelog intentionally untouched (no Unreleased section exists; release framing is the Director's).
- Implementation notes: one SQL placeholder bug (named `$` bound positionally) was found by the new tests and fixed before commit; the advisory is persisted inside the acceptance receipt so replays are exact; `kind: "rejection"` verified permitted end-to-end.
