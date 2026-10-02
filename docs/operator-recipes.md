# Operator and agent recipes

Loader, Manager and the CLI read and correct the same Lodestar database. Refresh
is explicit. Work status describes saved records; it does not observe live agents.
Use **Connection** to check the selected Node executable, CLI and database before
making a correction. Keep those exact selections during uncertain-save recovery.

## Ask for the answer you need

Loader's Commands search and Manager's **f** action finder use the installed
operation metadata. Search for the question, select the operation, and supply its
typed inputs. A no-match result leaves the question unresolved; narrow the query
or inspect the relevant project and source.

| Question | Read and interpretation |
| --- | --- |
| What was requested and what remains? | `work check` with the current intent ID and project root. Supplied passes are evidence mappings, not proof that Lodestar ran the tests. |
| What supports this claim? | `get` the cited ID and compare its revision. A different revision needs review. |
| Why was this decision made? | `decision show` for the project, optionally the exact key. Inspect its evidence and supersession history. |
| What research exists? | Scoped `find`, or `start --topic`; inspect source, applicability, observation date and limitations. |
| Did this save commit? | **Pending saves** in Loader or **Recovery** in Manager. Inspect the exact request and matching receipt before replay. |
| What inputs are accepted? | The selected operation's JSON `--help` or native `lodestar_describe`. |

## Project attention and guided capture

Loader's **Attention** tab and Manager's **Project attention** read work presence,
pending items, acceptance gaps and relevant-context gaps from one database
snapshot. Select an intent explicitly when several are listed. Each section reports
its coverage and offers a full read; an absent or unreadable intent is unresolved.
The separate **Recovery** observation describes local request journals and its own
refresh time. It is not part of the database snapshot. Refresh is explicit.

```json
["--db", "<database>", "work", "attention", "--cwd", "<project-root>", "--", "<intent-id>"]
```

Omit the final `--` and intent ID to discover available intents. Attention writes
no records. Follow its literal `read_args` before relying on an incomplete section.
The selectable inventory uses the same intent validator as `work check`, across
the project's current and historical scopes. Invalid records remain named issues
with exact reads. A full inventory may supply several argument arrays; execute
each separately against the configured CLI and database to cover those scopes.

Use **Capture / link** in Loader or **Capture knowledge / research / result** in
Manager to save a fact and associate it with the mission or stable requirement IDs.
The flow reviews two ordinary guarded saves:

1. Create and confirm the knowledge, research or result record. A result records
   an observation and its limits; it does not mark a requirement passed.
2. Read the confirmed record, prepare its association against the current intent,
   review the proposed change, then save it. Acceptance defaults to **unverified**.
   Choosing passed or failed is an explicit supplied assessment, with evidence.

Canceling or failing the second step keeps the saved record. Use its exact ID to
**link an existing record** after recovery; do not create it again. An unknown save
must be settled through its original journal before continuing. Conflicts require
fresh preparation and review. An unchanged association needs no save.

For agents, preparation is a read with a versioned draft schema, separate from a
mutation envelope. Inspect `work prepare-capture --help`. A result draft can be:

```json
{
  "version": 1,
  "stage": "create",
  "intent_record_id": "knowledge:intent",
  "author": "Operator",
  "record": {
    "id": "knowledge:focused-result",
    "type": "result",
    "name": "Focused verification",
    "body": "The selected check passed; the full product was not exercised.",
    "observed_outcome": "passed",
    "evidence_reference": "work/focused-check.log",
    "limitations": "Selected path only"
  }
}
```

```json
["--db", "<database>", "work", "prepare-capture", "--cwd", "<project-root>", "--file", "<draft.json>"]
```

Review the successful `data.input` and `data.write_basis`, then freeze them in the
existing contract-5 `put` request with one fresh request ID. Preparation creates no
receipt. After confirmed creation, prepare an `associate` draft naming `record_id`,
`context_target` and, optionally, `acceptance_result`. Typed help gives the full
strict schema, including explicit continuation fields when first initializing it.
The intent text/hash, unrelated results and associations are preserved. The
association pins the observed evidence revision and data hash.

Manager offers **p: Jump to project** in nested menus. Text and Save-confirmation
prompts treat `p` as ordinary input. Keep, discard or cancel a capture draft before
jumping; a kept draft retains its original project/runtime and needs fresh
preparation before Save. Pending journals keep their original binding.

## Exact invocation

Use the configured Node executable with the configured CLI entry as its first
argument, followed by the argument array. Replace the angle-bracket placeholders
with the actual values, preserving each value as one literal argument. These are
argument arrays, not shell fragments. When a resumed context supplies `read_access`,
use its executable, entry and arrays directly.

For record IDs that resemble options, place `--` before the literal ID:

```json
["--db", "<database>", "get", "--", "<record-id>"]
```

For raw inspection:

```json
["--db", "<database>", "get", "--raw", "--", "<record-id>"]
```

When a source-correction error supplies `identifiers.raw_read_args`, use that
literal argument array. Other errors may require the raw read shown above.
Keep its original numeric text and other evidence; a raw read does not correct it.

## First project

1. Open Loader's **Connection** and confirm the runtime/database selection. Use
   the portable setup described in [installation](installation.md) if unconfigured.
2. Create a project through the reviewed project action in Loader or Manager.
   Supply the actual root and human author; review before Save. Merely browsing a
   directory does not install anything or create a project record.
3. Refresh and select the project. Its context read verifies the root binding.
   If it disagrees, inspect the reported scope/root and use the explicit project
   correction workflow; do not relabel unrelated records to conceal a conflict.
4. Create the current project intent using the schema from `work check --help`.
   Give each requested outcome a stable requirement ID and an acceptance criterion.

Read the current project with:

```json
["--db", "<database>", "start", "--cwd", "<project-root>"]
```

## New work after an earlier completed task

**Update the intent consumed by the host before implementation.** An unrelated
progress note cannot update that intent's requirement, result or continuation view.
Keep existing requested outcomes and history. Record the newly accepted outcomes,
an honest unverified result, active requirement IDs and next action through a
guarded `put`. The intent hash must match the reviewed current intent; existing
test reports retain their original scope and revisions.

Run the current comparison:

```json
["--db", "<database>", "work", "check", "--cwd", "<project-root>", "--", "<intent-id>"]
```

Check that new unfinished work appears before relying on a later compaction.
With the separately installed OMX Lodestar bridge activated in the native Codex
host and a current project/session binding, ordinary PreCompact and compact/resume
events use this record automatically. Lodestar CLI, native-skill and portable
setup do not install or enable that bridge. Lodestar does not reconstruct
unsaved conversation changes.
Consequential changes need one coherent capture; routine reads and unchanged
checks do not need new knowledge records.

## Resume, missing context and packet preview

Read the labeled checkpoint status first. A confirmed older checkpoint and newer
current records are distinct facts. Reconcile the current comparison and required
omissions; do not overwrite newer work with the saved packet. If injection is
missing, run the current `work check` and read the relevant evidence directly.
The absence of a packet is not evidence that the work disappeared.

The separate OMX runtime supplies a read-only **checkpoint preview** entrypoint.
Use an installed OMX generation containing this entrypoint, enabled native hooks
trusted by the host, and an existing `.omx/lodestar-compaction.json` in the project.
The binding must contain exactly `project_root`, `intent_record_id`, `handoff_id`,
`session_id`, `node`, `cli` and `db`: the actual project root, current intent and
handoff IDs, native session ID, and selected existing executable/store paths.
The bridge checks the binding against the actual project and native session.
Host activation and binding configuration require separate authorization.

With the selected compatible Node executable, run:

```text
node "<OMX-runtime-root>/dist/scripts/lodestar-compaction-preview.js" --cwd "<project-root>" --canonical-session "<actual-host-session>" --native-session "<actual-native-session>"
```

Replace the placeholders with the installed runtime root and actual host-provided
session IDs. Preview reports the exact generated context, included record versions,
section sizes, omissions, required reads, latest attempt and last confirmed
receipt. It neither writes a checkpoint nor replays a request. Automatic
capture/resume depends on the activated host lifecycle; preview is optional.
Preview and checkpoint content may be private; they are not redacted support logs.

If the bridge, hook activation or binding is missing, or injection is unavailable,
use the configured Node executable and CLI entry with these public read arrays:

```json
["--db", "<database>", "work", "check", "--cwd", "<project-root>", "--", "<intent-id>"]
```

```json
["--db", "<database>", "get", "--", "<evidence-or-handoff-record-id>"]
```

Read the relevant evidence and reconcile current outcomes before continuing.
These reads use the selected core directly and require no checkpoint injection.

## Compact discovery and search

Use `find --compact` or `start --compact` for references and short snippets.
Compact results omit full evidence, source bodies and write basis. Read the
provided literal full-read arguments before dependent action or a guarded edit.
`requires_full_read`, `full_read_args` and the omission fields describe that
obligation. The native bounded resume context follows the same convention: it
lists what it could not include in `omitted_fields` and reports
`requires_full_read` with `required_action` for essential context omitted from
its checkpoint.
If an oversized record cannot fit, it is omitted whole; its literal ID is never
shortened into a different record. Follow the full page read to recover it.

The compact projection returns at most 20 records and 24,000 serialized data
bytes (the envelope is additional). Omitted rows/fields and snippet shortening
are explicit. A compact `start` requires the provided full start before relying
on instruction completeness. Exact read arrays that cannot fit are omitted whole
with an argument-file/stdin recovery path.

Default search retains contiguous matching. `find --match terms` requires every
distinct term, permits reordered words, and uses NFC normalization plus simple
Unicode lowercase. It does not expand synonyms, remove accents or treat rank as
confidence in truth. Use the current help for term, row and byte limits. Paging
continues at the returned revision; a stale page requires restarting the read.
Terms mode accepts at most 16 distinct whitespace-separated terms. Its snippets
are normalized search previews; full `get` preserves original source content.

## Unknown save or rejected save

Keep the saved request's exact UTF-8 bytes and request ID. A later rejection does
not prove an earlier timed-out attempt failed. **Pending saves/Recovery** preserves
that uncertainty and uses the selected runtime identity and original request.

For explicit replay, pass the saved file without regenerating or editing it.
Preserve the original project root and other typed invocation context from the
saved journal and reviewed operation. The operation's `argv` is its prefix;
it does not include that original context. Database and request bytes alone do
not select the right project when the caller's working directory has changed.

For a saved operation that used a project root:

```json
["--db", "<same-database>", "<saved-operation>", "--cwd", "<original-project-root>", "--file", "<exact-request-file>"]
```

For a dotted operation such as `decision.set`, use its typed `argv` array
(`decision`, `set`), retaining the original project root:

```json
["--db", "<same-database>", "decision", "set", "--cwd", "<original-project-root>", "--file", "<exact-request-file>"]
```

Do not guess how to split an operation or replace its original scope context.
Read its receipt/current record afterward. Resolve instance, epoch, request-ID
or basis conflicts against the reported identity before preparing a new request.
A definitive first-attempt rejection gives a correction; an unresolved prior
attempt remains unresolved. Storage preparation errors identify an unsent current
attempt separately from older saved requests.

COMMIT or rollback confirmation failures also need receipt reconciliation, even
with a valid error envelope. A connection cleanup error can explicitly report a
confirmed commit; preserve that fact and check its receipt. Manager and Loader
retain the first uncertain response separately from the latest attempt in the
original producer's journal. Shared recovery discovers and validates these
producer journals without rewriting them. A rejected later replay cannot erase the earlier unknown
outcome. Storage failures while preserving that provenance stop replacement and
identify the retained bytes and corrective action.

### Shared recovery and journal ownership

Use the same database and interface configuration in both applications. Loader
refreshes shared recovery during capability discovery and explicit library
refresh. Manager's Recovery menu includes a shared CLI/Loader section.

```json
["--db", "<database>", "recovery", "list", "--interface-config", "<interfaces.json>"]
```

```json
["--db", "<database>", "recovery", "replay", "<listed-key>", "--interface-config", "<interfaces.json>"]
```

Replay returns the original mutation operation's envelope. Use a listed opaque
key to choose one folder; it never substitutes a new request ID or body.
`journals` contains unresolved or malformed entries. `settled_journals` contains
validated response snapshots with context/request hashes so the native reader
can recognize a completed request from another producer. It does not assert that
the current record still has the saved value. `errors` names inaccessible
roots and `complete` reports discovery coverage; `other_database_journals` counts
entries excluded by the selected database path. A malformed entry stays visible
with replay disabled and an inspection action. Failed refresh keeps the last
listing and reports that it is stale or incomplete.

Manager retains journals beside its configuration (or database for a direct
selection). Loader retains its existing user-local pending folder. Bare guarded
CLI mutations freeze exact UTF-8 request bytes in `cli-pending` beside the
database before dispatch. After delivering a complete success response, the CLI
retires only the duplicate journal created by that invocation. Interrupted or
uncertain responses retain exact request bytes and receipt identity for
reconciliation. Completed receipts do not count as unresolved saves.
These directories contain private request data; keep them in trusted local
storage and preserve their permissions. POSIX CLI journal files use mode 0600
and directories 0700; Windows inherits the selected local directory's access
controls. No background process watches or replays them.

CLI capture preserves the exact UTF-8 request, including a transport BOM. Domain
commands also freeze the absolute project path and caller arguments. Reusing a
request ID with changed bytes or arguments is refused before dispatch; choose
the saved key through `recovery replay` to reconcile the original attempt.
Existing, replayed and other producers' journals remain available; recovery does
not purge them automatically. A cleanup warning after success identifies a
separate storage problem, the remaining journal and public receipt-read arguments.
Preserve those files and inspect the receipt before further action. If neither
output channel can deliver that warning, the CLI returns a transport failure and
retains available evidence. A lost original response remains an uncertain write.

Record retirement preserves database history. Receipts, backups and retained
recovery evidence can contain earlier content. This release provides no secure
erasure or automatic retention-period policy.

The bare CLI captures ordinary and domain mutation requests. Explicit store
creation/conversion, recovery promotion and native skill installation retain
their separate guarded lifecycle; this record-recovery command does not replay
those operations.

### Ordinary record retirement and links

In Manager, select a verified project, open **Human actions**, and choose **r:
Retire ordinary record**. Loader provides **Retire ordinary record** in its
action menu. Supply the exact current record ID, author and reason, then review
and save the guarded request. Original contents and history remain available;
project catalog records and domain records retain their dedicated workflows.
These actions currently target ordinary records in the selected project.
Use the public guarded `delete` command for a deliberate global-record retirement.
Loader's record **Links** button opens its existing typed read with the exact
record ID and an explicit page limit.

### Exit-code contract

JSON and human help publish `exit_codes`. Code 0 is confirmed success; 1 is an
unexpected/internal failure; 2 is invalid input or identity; 3 is missing or
conflicting state; 4 reports integrity/schema failure or a successful diagnostic
with an unhealthy, unverified or unready result; 5 reports storage/database or
response-delivery failure. Inspect `ok` and the operation's diagnostic data for
code 4. An exit code alone cannot settle a dispatched mutation: verify its exact
request, database identity and receipt. Diagnostic code 4 is supported by doctor,
skills verification, agents verification and setup.

Handoff and decision reads accept `--limit`, `--offset` and `--at-revision`.
Follow their literal `next` argument arrays while `more` is true. Decision limits
bound presentation after complete causal replay; omitted historical items do
not change the current decisions. Bare `decision` means `decision show`;
`decision status` is a write requiring a guarded JSON request. `get` also accepts
`--at-revision` and rejects a changed store basis.

`export` produces private raw JSON evidence. It is not a SQLite backup image and
cannot be supplied as a recovered image to doctor/recovery promotion.

## Review research freshness

`updated_at` dates a record edit. It does not date the source event or prove a
source was rechecked. Inspect the saved locator, claim, body hash and limitations.
Use the explicit source-review action after inspecting the source yourself. It
records an **operator attestation**: `reviewed_at`, `reviewed_by`,
`source_version`, `review_qualifiers` and `review_acquisition`.
An unavailable source remains unresolved. Opening the action does not fetch or
verify the source, and it creates no background refresh.

## Identify the selected build

Loader's Connection view and Manager's connection summary show release versions,
contract/schema support, runtime generation, configuration fingerprint and observed
core source digest separately. Loader also reports its assembly identity and file
hash. Matching release labels alone do not establish matching bytes.

`source_inventory` means the selected source bytes were observed; package payload
verification is unavailable. `verified_manifest_core` means manifest-listed core
bytes were checked, with the displayed scope notice. It does not attest the whole
bundle, its origin or the database. Keep that notice with a support report. A
successful CLI `--version` reports supported contract/schema versions without
opening a database; the selected store's identity/schema requires a real read.

## Storage failure and safe diagnostics

For capacity failure, inspect the identified database/storage location, free
space, quota and SQLite page limit. Preserve exact pending requests before
reconciling their receipts. A hot-journal recovery error requires preserving the
database and matching journal together. Use the explicit recovery-preflight and
tested backup procedure in [storage and recovery](../README.md#storage-and-recovery)
on a separate copy; ordinary reads do not silently switch to writes or delete a
journal. Do not initialize a new database over a damaged or uncertain store.

The Windows default remains DELETE/FULL. File flushing, process-crash recovery
and logical restore checks do not certify sudden-power-loss retention on every
filesystem or device. Local storage with SQLite-compatible locking/sync behavior
is expected; UNC, mapped, cloud-synchronized and otherwise unknown storage need
deliberate suitability review. A local-looking path alone proves no such guarantee.

**Share only selected diagnostic metadata**: application/core build, operation,
error code/category, exception type, correlation ID and timestamp. Loader's
bounded diagnostic records exclude original exception messages, record bodies,
arguments and secrets. Exact request journals, checkpoint previews, raw records
and support screenshots can contain private information. Keep them local unless
their particular contents have been reviewed. Never prune an unresolved request
to make the Pending saves list look clean.
