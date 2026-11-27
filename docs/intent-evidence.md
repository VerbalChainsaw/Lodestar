# Intent and recorded evidence

`lodestar work check --cwd <project-root> -- <intent-record-id>` reads one current, project-scoped `knowledge` record and its named evidence records. It reports whether the **supplied** acceptance mapping is complete enough for human review. It does not run tests, inspect arbitrary files, verify a human's conclusion, authenticate native task IDs, or mark work done. Ordinary `put` updates remain the only way to change this data.

Use an exact record ID. `work check` accepts `--at-revision <n>` to require a specific database snapshot. It does not accept `--limit` or `--file`; `work status/history` continue to accept `--limit`.

Place options before `--` and the literal ID, decision key or query after it. This also reads names such as `--help` and `-h` exactly: `lodestar get -- --help`, `lodestar decision show --cwd <project-root> -- -h`, or `lodestar find --scope <project-scope> -- --all`. A successful help response is not the requested record. Follow the operation-specific argument arrays supplied by the host or typed CLI help.

## Knowledge record data

Store this object as the `data` of a current project `knowledge` record. `intent` is required. `acceptance`, `tasks`, and `continuation` may be added later with a checked `put`. The command's JSON help and native `lodestar_describe` include the `work.check` operation, its argument bindings, and this data schema.

```json
{
  "intent": {
    "version": 1,
    "brief": "The Director's requested outcome in their terms",
    "user_reference": "An exact user message, ticket, or other retrievable reference",
    "requirements": [
      { "id": "R1", "text": "Preserve the current behavior", "acceptance": "Run the focused test and inspect its output" },
      { "id": "R2", "parent_id": "R1", "text": "Record the test result", "acceptance": "Review the evidence record" }
    ],
    "boundaries": ["Keep the existing database authority"],
    "non_goals": ["Do not control host sessions"]
  },
  "acceptance": {
    "intent_sha256": "<lowercase SHA-256 of canonicalStringify(intent)>",
    "results": [
      {
        "requirement_id": "R1",
        "status": "passed",
        "evidence": [
          { "id": "knowledge:focused-test", "revision": 42, "data_sha256": "<optional lowercase SHA-256 of the referenced version's canonicalStringify(data)>" }
        ],
        "notes": "Explain why this record supports the stated acceptance procedure."
      },
      { "requirement_id": "R2", "status": "unverified", "evidence": [], "notes": "Awaiting review" }
    ],
    "blockers": []
  },
  "tasks": [
    { "runtime_task_id": "task-123", "owner": "agent-name", "requirement_ids": ["R1"], "status": "reported-complete" }
  ],
  "continuation": {
    "active_requirement_ids": ["R2"],
    "next_action": "Review R2 evidence",
    "context": {
      "version": 1,
      "mission_record_ids": ["knowledge:one-authority-rejection"],
      "requirements": [
        { "id": "R2", "record_ids": ["knowledge:focused-test", "decision-event:chosen-route"] }
      ]
    }
  }
}
```

Use the same `canonicalStringify` as Lodestar when computing either digest. The intent digest covers **only** the `intent` object, so changing acceptance results does not change it. The optional evidence digest covers **only** the `data` of the named evidence version. A digest is a content identity check, not proof that a test ran or a claim is true. The `tasks` array is advisory: its strings do not establish actor identity, runtime liveness, ownership, or completion.

Every requirement needs a distinct, nonempty ID, text, and acceptance procedure. Optional `parent_id` names another requirement in the same intent; missing parents, self-parenting, and cycles are invalid. Omitting all parents preserves the flat shape. Every supplied result must have a distinct known requirement ID, one of `passed`, `failed`, or `unverified`, an evidence array, and notes. A review-ready `passed` result needs at least one distinct evidence record ID with a positive recorded revision and a nonempty note explaining relevance. Optional `continuation` names distinct existing active requirement IDs and a nonempty next action. It records an operator or host handoff hint; it does not open, control, or authenticate tasks. Invalid fields, duplicate IDs, malformed evidence references, or zero requirements return `invalid_intent_contract` with the field pointer. An absent acceptance report returns a readable `missing_acceptance` issue.

## Relevant context without changing approved intent

Optional `continuation.context` associates existing records with the mission or a
known requirement. Version 1 requires both arrays shown above, distinct mission
record IDs, distinct known requirement IDs, and distinct record IDs within each
requirement association. Empty arrays are valid. Missing records produce read
gaps; malformed associations return `invalid_intent_contract` with a field
pointer. Explicitly empty `active_requirement_ids` preserves an empty branch;
when continuation is absent, the projection uses unfinished requirements.

The associations sit outside `intent`, so editing them changes the containing
record revision while preserving `intent_sha256` and otherwise valid acceptance
mappings. They guide retrieval and confer no execution authority. An older core
with the strict previous continuation schema refuses this optional field. Inspect
current typed help before editing it; rollback requires deliberate checked removal
or the newer core, retaining history. Reads do not upgrade stored records.

## Reading the report

`ready_to_review` is true only when the intent hash matches, every requirement has an explicit `passed` result with explained evidence, each referenced revision is the **current revision** of its record in the selected project, and `blockers` is empty. A later edit may correct or contradict an earlier record, so an old revision cannot support current readiness even when `get --history` still preserves it for inspection. Evidence from the current or admitted historical **project scopes** is allowed. Missing, unreadable, retired, superseded, unavailable, out-of-scope, revision-mismatched, or hash-mismatched evidence leaves the report unresolved. Historical immutable work/decision events and handoff packets retain their existing inspection and evidence behavior; a superseded fact cannot establish current readiness.

Each issue has a code, location IDs when relevant, and an action. `next` collects those actions without duplicates. `complete` means every referenced current record was readable; it does not mean the requirements passed or that named revisions stayed current. `record_errors` names references whose stored records could not be read. `write_basis` includes the intent, every referenced evidence ID (including absent IDs), and project binding targets so a later correction can use current preconditions. A read never returns a mutation receipt and does not gate `work done` or any other write.

The `plan`, `actual`, and `delta` fields are deterministic views of this same read snapshot. `plan` carries the current brief, user reference, boundaries, non-goals, intent identity/hash, and requirements in recorded order, with `root_ids`, `parent_id`, and `child_ids` for the tree. `actual` carries supplied acceptance statuses, notes, evidence references, current readable evidence identities, and advisory task references. It makes no fresh test or runtime claim. `delta` carries issues and derived status for each requirement: `not_started`, `failed`, `unverified`, `stale_intent`, `reported_complete_needs_evidence`, `awaiting_descendants`, or `reported_complete_with_current_evidence`. A parent reaches the last status only when its own acceptance mapping and every descendant mapping meet the read check. Global issues, such as a blocker, still prevent overall `ready_to_review`; an intent hash mismatch also marks supplied passed results as `stale_intent`. These status names describe recorded mappings; they do not certify the underlying claim. The top-level `continuation` is the exact recorded object, or `null` for older records. Checkpoints may save this view but do not change the plan or imply progress.

After a conflict, reread the intent and named evidence at the new revision. Correct `data.intent`, `data.acceptance`, or the evidence records with their fresh write bases and a new logical request ID. Re-run `work check` before human review. Repeating the read with the same `--at-revision` yields the same report while that revision remains current; a changed store returns `read_revision_conflict`.

## Continuity coverage and exact reads

The same `work check` read returns `continuity.version: 1`, its
`association_mode` (`legacy_defaults` or `explicit`), active requirement IDs,
selected normalized `records`, resolved `decisions`, `issues`, `read_required`,
`complete`, `truncated`, `limits`, and `omitted`. Each selected record carries
`selection.reasons` and `selection.requirement_ids`. Decisions retain the current
production replay result or a named conflict/unavailable result, selected event
IDs, revisions, source direction and provenance. A superseded selected event
requires reading the current stream; it cannot revive an older choice.

Selection follows explicit associations and `requires`/`depends-on` links,
admitting current/historical project scope and applicable global records while
checking checkout applicability on every edge. Active requirements include their
ancestors and unfinished descendants. Applicable orientation constraints and
rejections remain available with their reasons. Missing, retired, foreign,
unreadable or oversized context stays unresolved with a corrective read. Stored
claims and attribution remain evidence to reconcile with source and current user
direction; a successful read does not prove that a claim is true.

`continuity.complete` describes coverage of that declared selection within its
bounds, separately from acceptance readiness or complete project knowledge.
The initial bounds are 256 inspected nodes, 1,024 inspected edges and 128 KiB of
UTF-8 continuity JSON. `limits` reports usage. `omitted.known_ids` names the known
frontier; `deeper_count_unknown` means an exact deeper count is unavailable.
Extreme active-ID overflow reports `active_requirement_ids_omitted`. Whole
records remain retrievable; repeating the same bounded projection cannot resolve
the same oversized branch.

Use each `read_required.read_args` as literal arguments to the configured CLI,
preceded by its existing executable and `--db` setting. Public reads are
`["get", "--", <id>]`, source correction can use
`["get", "--raw", "--", <id>]`, and decisions use
`["decision", "show", "--cwd", <project-root>, "--", <key>]`. A root
`work check` read diagnoses overall coverage; inspect the named record/links or
decision stream to resolve omitted material. Follow the accompanying action.
Failed or empty reads leave the needed fact unresolved. These arrays contain no
shell command or authority to execute record text. Work checks and these reads
create no receipts, revisions or record updates.

## Capture and resume

The native OMX candidate carries the core continuity projection in the existing
owned handoff reference. Its semantic signature includes selected record versions
and decision heads, excluding unrelated global revisions. Valid older handoffs
remain readable; absent continuity metadata means unknown coverage. An old exact
pending request resolves using its saved bytes before any upgraded checkpoint is
prepared. The first new semantic checkpoint may write once; unchanged subsequent
checks preserve the receipt and database revision.

Each resumed contribution repeats a self-contained mission, guardrails, current
work and required reads, with recovery first. Its 7,000 JavaScript UTF-16-code-unit
cap is separate from the core UTF-8 bound and the native host's delivery limit.
Whole IDs and read arrays survive where possible; shortened reasons or omitted
rows set `must_read_before_action` and expose their exact reads or the existing
binding fallback. `previewCheckpointContext` is the existing read-only native
adapter export and uses this same production formatter; it is not a new Lodestar
CLI operation. Preview and fixtures establish generation, not actual automatic
delivery or measured benefit over ordinary compaction. Live activation and the
paired usefulness comparison require their own evidence.

New projections add `selection.order` and `selection.reason` across both record
and decision rows. Active associations and their dependency closure enter before
ancestors/unfinished descendants, mission dependencies and orientation. Within
each band, relevant constraints/rejections and current decisions precede general
record bodies. The native candidate uses this combined ordering within its
existing cap; older projections retain their established order. If repeated read
paths consume too much room, the native packet explicitly counts the omitted
catalog in `read_required_omitted` and supplies a current `work check` read to
recover the named record/decision reads. The mandatory-read flag remains set.

For reviewed creation and requirement association, use the read-only
`work prepare-capture` draft contract and two existing guarded `put` saves. See
[guided capture](operator-recipes.md#project-attention-and-guided-capture).
`work attention` supplies section-level coverage over one current snapshot;
local recovery observations remain separate.

A restored checkpoint covers saved records. Reconcile the latest user request and current task before accepting a completion claim: newer unsaved work may be absent. When persistence is unavailable, preserve the active task and unresolved outcomes in its existing workspace checklist, retain the bound record IDs, and report the fallback. Restore workers from the actual host runtime rather than assuming that a saved worker ID is still running.

Record consequential facts while the work happens: accepted boundaries, decisions and their reasons, research with sources and limits, meaningful test results and failures, evidence record versions, open requirements, and the next action. Keep those facts in the existing records and link evidence to the relevant requirement, including `unverified` or `failed` outcomes. A compacting host reads these records; it cannot recover unsaved conversation context. Avoid a new knowledge entry for routine reads, narration, repeated identical errors, or every tool call. Reference bounded raw logs by path and digest when they are useful evidence.

A host checkpoint can save the `plan`, `actual`, `delta`, and `continuation` view. A fresh semantic comparison may find that the saved handoff already contains the same meaningful projection. In that case a checked local attempt keeps the prior saved receipt; it creates no new Lodestar mutation receipt or database revision. A changed projection uses a fresh `write_basis` and a new request ID. An unresolved exact request takes precedence over either comparison. A linked record's version may change the meaningful projection even when the words of its status have not changed; unrelated global database edits alone do not imply checkpoint progress.

On resume, distinguish the latest checkpoint attempt from the prior confirmed `last_good` and the current public read. If the latest dispatched outcome is unknown, retain the saved exact request and its ID. One automatic exact replay is the limit for that logical request; subsequent recovery requires explicit inspection and replay of the pending request body from its saved pointer. A permanent rejection or database, epoch, or request conflict stops blind replay. A stale write basis requires fresh reads and a new logical request only after the prior outcome is resolved. Neither `last_good` nor a saved `passed` mapping establishes that current work is complete. Use the host's literal `read_access` argument arrays and the question map in the Lodestar continuity reference to retrieve the current intent, handoff, decision, and cited evidence versions.
