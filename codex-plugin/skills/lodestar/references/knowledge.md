# Scoped knowledge

Use `lodestar get <id-or-alias>` for an exact subject, `lodestar find <query>` when the
identifier is unknown, and `lodestar links <id-or-alias>` for one explicit relationship
hop. Add a positive page limit only when the caller actually wants a page. Missing
knowledge means Lodestar lacks the record; inspect the source normally.

Reads return current records with provenance, semantics, source status, and a usable
write basis. `get --history` retrieves retained revisions and associations. `get --raw`
preserves exact evidence for a malformed legacy numeric row that cannot safely enter
JavaScript's normalized number domain.

During authorized work, update an existing subject once when its meaning or evidence
changes. Send a complete contract-5 request containing `v: 5`, `request_id`,
`write_basis`, and `input`; the core supplies incidental hashes and revision mechanics.
For `input.mode: "update"`, both an object `set` and an array `remove` are required;
use `remove: []` when removing nothing. Validate the envelope and mode-specific
required fields against `lodestar put --help` before submission. Retire a subject
through `delete` so current orientation omits it while exact history remains available.

Ordinary `get`, `find`, and linked-peer reads refresh local file and package
manifest evidence. `current_source_status` and `claim_status` are read-only
annotations; stored source fingerprints and content remain the original observation.
A `needs_reinspection` result calls for inspecting the affected source before relying
on that claim. Raw reads, history, and exports preserve saved evidence exactly.

For contract-5 `put` updates, include both an object `set` and an array `remove`
(use `remove: []` when no data keys are removed). The runtime requires both even
when the help schema does not make that obvious. `get` returns the record directly
under envelope `data`, not `data.record`. Use the process working directory for
ordinary `get`/`find`; do not copy `start --cwd` onto commands that do not advertise
that option. Filter large `find` responses before printing them. On a mature project,
`start` can return a large orientation; capture it with `--output <new-file>` and read
only the sections you need.

Use `lodestar <command> --help` in JSON mode, or native `lodestar_describe`, for
the complete mutation envelope and operation input schema. `decision show` reads
the stream; `decision status` changes its status. Do not guess write fields.

An explicit canonical project mapping allows corrections through a fresh returned
basis while retaining the record's origin scope. Rebinding revisions are checked;
knowing an unrelated project's record ID does not make its domain writes applicable.

Source freshness is evidence, not age-based authority. Inspect and hash the same stable
bytes, preserve prior observations, and mark an unstable or changed source for
reinspection rather than claiming current verification.

## Capture against the current intent

`work prepare-capture --cwd <project-root> --file <draft.json>` is a read-only
preparation operation. Its JSON help publishes `draft_schema` version1 separately
from the mutation schema. A create draft names the intent, author and one knowledge,
research or result record; a result records an observation and limits without
inferring acceptance. Review the returned `data.input` and `data.write_basis`, then
save through the existing contract-5 `put` request/journal. Allocate the record ID
once and preserve it through recovery.

After confirmed creation, freshly prepare an associate draft naming that record,
the mission or stable requirement IDs, and any deliberate acceptance assessment.
Acceptance defaults to unverified in Loader/Manager. Prepared associations preserve
approved intent and unrelated results, and pin the current evidence version/hash.
An unchanged association reports `review.noop:true` and needs no mutation.
Cancel or failure after creation keeps the record: link its existing ID later.
Unknown outcomes require exact-request reconciliation before another step;
conflicts require fresh preparation and review. Preparation never returns a receipt.

`work attention [<intent-id>] --cwd <project-root>` reads work, pending items,
acceptance and context gaps coherently. Select an intent explicitly when several
exist. Each section reports coverage and literal full reads. Local request recovery
is a separate observation. These reads create no records or progress claims.
Selectable intents use the existing intent validator and current/historical project
scopes. Invalid records remain named issues with exact reads. When a full inventory
supplies several argument arrays, execute each separately with the configured CLI
and database before relying on the omitted intents.

A current `content_owner` backed by a local file or package manifest is re-read before
write admission and must match its exact locator, byte count, and SHA-256. A
`source_root` locator includes `source_id`; retain the returned
`config:lodestar:sources` precondition so a root change cannot reuse the old basis.

## Settled rejections (never revisit)

Record an element the project has settled against — a rejected model, data set,
architecture, or approach — as a `kind: "rejection"` record so future sessions are
intercepted before re-proposing it. One rejection per subject. Convention: the
record's `data.subject` carries the exact subject terms (the write-time advisory
matches it case-folded), `data.verdict` is `"never-revisit"`, `data.reason` is one
line, `priority` is set explicitly so orientation orders it, and `semantics.subject`
carries the rejection-scoped slug (`rejection:<slug>`) so a duplicate rejection
conflicts instead of accumulating — subject uniqueness spans all record kinds, so
never reuse a plain domain slug here. Orientation and
the write-time advisory surface rejections whose scope is the project or `global`
with `semantics.applicability.project` set to the project; `find` reaches rejections
in every scope. Treat a rejection search hit or advisory line as a settled verdict:
stop, read it, and reopen it only through an update that carries actual user
direction. Retire a rejection through `delete` or by updating `semantics.lifecycle`
to `historical` or `superseded` with a `retirement_reason`; current orientation then
omits it while exact history remains.

```json
{
  "v": 5,
  "request_id": "018f-example-rejection-create",
  "write_basis": {
    "database_instance_id": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "database_epoch": "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    "project_scope": "project:example",
    "checkout": null,
    "targets": [
      { "kind": "record", "id": "project:example", "expected_revision": 4 },
      { "kind": "record", "id": "rejection:materialized-views", "expected_revision": null }
    ]
  },
  "input": {
    "mode": "create",
    "record": {
      "id": "rejection:materialized-views",
      "kind": "rejection",
      "name": "Materialized views — rejected",
      "scope": "project:example",
      "availability": "known",
      "priority": 200,
      "data": {
        "subject": "materialized views",
        "verdict": "never-revisit",
        "reason": "Rebuild cost and staleness outweighed read speed; revisit only on recorded user direction."
      },
      "aliases": ["materialized views", "matview approach"],
      "links": [],
      "sources": [],
      "semantics": {
        "subject": "rejection:materialized-views",
        "basis": "asserted",
        "lifecycle": "current",
        "context_role": "orientation",
        "applicability": { "project": "project:example", "checkout": null }
      }
    }
  }
}
```

Retire or supersede a rejection with an update that keeps both `set` and `remove`:

```json
{
  "v": 5,
  "request_id": "018f-example-rejection-retire",
  "write_basis": {
    "database_instance_id": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "database_epoch": "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    "project_scope": "project:example",
    "checkout": null,
    "targets": [
      { "kind": "record", "id": "rejection:materialized-views", "expected_revision": 5 }
    ]
  },
  "input": {
    "mode": "update",
    "id": "rejection:materialized-views",
    "set": {
      "semantics": {
        "subject": "rejection:materialized-views",
        "basis": "asserted",
        "lifecycle": "superseded",
        "context_role": "orientation",
        "applicability": { "project": "project:example", "checkout": null },
        "retirement_reason": "Superseded by the 2027 read-path redesign."
      }
    },
    "remove": []
  }
}
```
