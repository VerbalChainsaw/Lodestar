# Continuity

Continuity preserves an explicit checkpoint; it never creates, resumes, or rotates a
host session. The current commands are:

- `lodestar handoff status|history`
- `lodestar handoff arm|checkpoint|now|claim|disarm --file <request.json>`

Writes use the same contract-5 request, basis, receipt, and revision rules as every
other mutation. The structured input is declared by the installed package. Preserve
the task goal, accepted constraints, completed work, current state, exact next move,
and evidence needed to continue. Do not infer a decision or success from arbitrary
conversation prose.

Claims require actual host actor/session identity. A native tool that cannot obtain
authenticated host identity must leave it absent and return the resulting identity
error; it must never fabricate a user, session, or claimant.

History and closed packets remain retrievable. A pending transfer is claimed at most
once through an explicit checked mutation. Failed or interrupted attempts remain
retryable, and a lost successful response replays from its request receipt. Lodestar
does not capture message tails or maintain a private session authorization cache.

## Plan and evidence checkpoints

Keep the requested outcomes in one current project knowledge record using the
`work check` data schema. Stable requirement IDs link supplied results, evidence
revisions and native task references. Optional parent IDs form a tree; optional
continuation records the active requirements and next useful action. Use
`lodestar work check --cwd <project-root> -- <intent-record-id>` to calculate the
current plan, actual and difference views. A reported pass remains a supplied
claim until its evidence is reviewed; task references do not prove liveness.

Optional `continuation.context` version 1 names `mission_record_ids` and
`requirements` entries with a known requirement `id` and `record_ids`. Associate
consequential existing rejection, decision and research records with the mission
or the requirement they support. These retrieval hints are outside `intent`:
changing them preserves the approved intent hash and acceptance meaning while
changing the containing record revision. Empty arrays are valid. Inspect current
typed help; older cores refuse this optional field rather than silently ignoring
it. Reads never rewrite old records or grant authority from an association.

`work check` returns one versioned `continuity` projection from the same snapshot.
It selects applicable mission/branch context, explicit dependencies and current
decision streams; it retains reasons, revision identities, provenance and
selection associations. A link cannot grant project or checkout applicability.
Superseded choices stay historical; a named current decision read resolves them.
Unknown direction remains unknown. Stored records are attributed evidence to
reconcile with the latest user request and current source.

Coverage is separate from acceptance: `continuity.complete` describes the
declared selection within its resource bounds, never complete project knowledge
or successful tests. `association_mode` distinguishes `legacy_defaults` from
explicit hints. Missing, retired, foreign, stale, unreadable or oversized context
produces `issues` and exact `read_required` arrays. `limits` bounds inspection to
256 nodes, 1,024 edges and 128 KiB of UTF-8 continuity JSON. `omitted.known_ids`
names the known frontier and `deeper_count_unknown` preserves unknown deeper
counts. Extreme active-ID overflow names `active_requirement_ids_omitted`.
Repeatedly reading the same bounded work check cannot recover an oversized branch;
follow the named record/links or decision reads.

`selection.order` and `selection.reason` rank record and decision rows together.
The core admits active associations/dependencies before related branches, mission
dependencies and orientation, so unrelated orientation cannot exhaust the active
frontier. Ranking is usefulness, never truth or execution authority. The native
candidate preserves this order within its existing cap. When repeated read paths
cannot fit, it counts omitted paths in `read_required_omitted`, requires a current
work read, and keeps `must_read_before_action`. Use that read's exact named paths
before dependent work. Older projections remain compatible.

When the Director accepts new work after a previous delivery, update the current
intent actually bound to the host before implementation. Append the new stable
requirement IDs, honest unverified results and active continuation while retaining
previous outcomes and history. A separate task note alone is not a linked active
plan and cannot redirect that host's checkpoint. Reuse the current read basis;
do not choose the newest unrelated note or fabricate progress to refresh context.
Confirm `work check` exposes the accepted work and next action. Compaction then
checkpoints those current references through the ordinary automatic lifecycle.

A host compaction adapter may save those references through `handoff checkpoint`.
The host owns lifecycle delivery and pending-request recovery. Lodestar does not
install or run compaction hooks. Before compaction, checkpoint already structured
facts; compaction does not authorize changing the goal. Record consequential
decisions and reasons, sourced research and its limits, meaningful results and
failures, evidence revisions, unresolved requirements, and the next action during
work. Reuse existing records and group coherent updates. Routine reads, repeated
identical errors, and each tool call do not need knowledge entries. A hook cannot
reconstruct facts that were never recorded or detect a native event that was never
delivered.

After a fresh coherent read, a host may compare the full semantic checkpoint with
the saved handoff. If it is unchanged and no write is pending, the host records one
local checked attempt while retaining the prior saved receipt and database
revision. It sends no `handoff checkpoint` mutation, creates no new database
receipt, and claims no new work. A changed checkpoint uses the fresh `write_basis`,
one new logical `request_id`, and an exact request saved before dispatch. Relevant
linked record-version changes remain visible; an unrelated global revision alone
is not checkpoint progress. After resume, read current intent and evidence and
reconcile the saved references. Do not write an older checkpoint over newer
records.

Use the actual observed target basis, including an absent-target basis for a new
handoff. Keep the exact request and ID after an unknown response; replay that
request at most once automatically before preparing another. If that replay is
still unknown, stop automatic attempts and use explicit recovery: inspect the
saved session-state pointer, extract its pending `request_text` body unchanged,
and submit it to the configured executable/CLI with the same request ID. Never
reconstruct that body from the summary or issue a fresh request while its outcome
is unresolved. A permanent rejection or database, epoch, or request conflict
stops blind replay. A stale basis requires fresh reads and a new logical request
only after the prior outcome is resolved. Keep `last_good` as the last confirmed
receipt, not proof that the latest attempt succeeded or current records match.
Report the latest attempt, prior `last_good`, and current read separately. Generic
public handoff string references remain valid. See the package's
`docs/intent-evidence.md` and `lodestar work check --help` for the record schema
and interpretation limits.

The native adapter saves this continuity alongside its existing owned work-check
reference. A legacy reference without it stays valid with unknown coverage. Resolve
an old pending exact request before preparing the new semantic checkpoint. An
upgrade may produce one new checkpoint; identical later checks produce no
Lodestar mutation. The existing native `previewCheckpointContext` export uses the
production formatter without replay or writes. It previews generation only;
fixtures do not prove automatic native delivery or improvement over ordinary
compaction. Lodestar supplies no separate preview command or hook manager.

## Reads after resume

Use the literal argument arrays in the host's `read_access` with its configured
Node executable and CLI entry. Append only the stated literal ID, topic, or
query to a prefix; do not turn the arrays into shell code.

Continuity `read_required.read_args` already contains the complete public read
arguments without the executable or database switch. Prepend the configured CLI
entry and `--db` value. Allowed reads include `get -- <id>`, `get --raw -- <id>`
for quarantined source correction, and
`decision show --cwd <project-root> -- <key>`. Follow the supplied correction
action. Failed or empty results leave the required fact unresolved. Routine reads
create no record, receipt or database revision.

| Question | Public read |
| --- | --- |
| What is the mission, acceptance check, or remaining difference? | `current_work_check_args` |
| What did the saved checkpoint contain? | `saved_handoff_get_args` |
| What proves a particular claim? | `record_get_args_prefix` plus one referenced record ID; compare the returned revision |
| Why was this decision made? | `decision_show_args`, optionally with its documented decision key |
| What research exists on this topic? | `project_topic_args_prefix` plus one literal topic, or `find_query_args_prefix` plus one literal query |
| What inputs are supported? | `cli_help_args` |

The bounded resume block is built from Lodestar records only and can carry active
requirement text, acceptance, supplied status and evidence IDs with revisions,
relevant boundaries and non-goals, differences, and next action. When essential
material does not fit it names omissions in `omitted` and continuity
`read_required`; `must_read_before_action` carries the obligation to resolve them.
The native contribution is capped at 7,000 JavaScript UTF-16 code units, distinct
from core UTF-8 bytes and the host's delivery limit. Whole identifiers and argument
arrays remain intact; extreme overflow points to the existing binding and current
public reads. Read the omitted source before
dependent action. A linked evidence version can be stale even if `get` finds the
record; compare revisions and rerun `work check`. A recorded `passed` status or
`ready_to_review` is a supplied mapping for review, never independent proof that a
test ran.
