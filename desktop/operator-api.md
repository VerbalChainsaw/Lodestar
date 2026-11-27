# Operator readout API

## Requirement capture and association

`LodestarService.PrepareCaptureAsync(ProjectSummary, JsonElement draft, CancellationToken) -> EditReview`
uses the described `work.prepare-capture` read and its version-1 `draft_schema`. It verifies the returned stage, IDs, review, put shape, allowed association fields, exact basis and read arguments, then freezes the returned ordinary put input through the existing human envelope. Domain association and acceptance construction remain in the core. Unsupported or malformed responses produce no frozen mutation or journal. `SaveAsync` retains its existing exact-byte journal/recovery behavior.

Capture / link offers knowledge, research, observed result, and existing-record selection. The form retains the chosen intent brief/active branch, allocates a create ID once, supports mission/requirement context and context-only association, and defaults recorded acceptance to **unverified**. A confirmed creation retains its ID visibly and switches to association; that second stage requires fresh Review and Save. A rejected or cancelled association retains the created record and can resume through Link existing record. An unknown outcome keeps exact recovery and prevents a new review in that form until the original request is settled. No workflow database or compensation delete is added.

## Project attention

`ReadAttentionAsync(ProjectSummary, string? intentId, CancellationToken) -> CliResult` calls one described `work.attention` read and admits only the version-1 section contract, selected project/intent and observed store identity. The project Attention tab refreshes explicitly, keeps the recorded work/pending/acceptance/context section coverage, omitted counts, issues and literal follow-up reads, and displays Recovery as a **separate journal observation** with its own read time and runtime/database paths. Each unresolved request remains visible with selected-project, other-original-project or scope-unknown attribution, plus its original root/database; Recovery inspects or replays its unchanged saved binding. Refresh preserves the capture draft. Obsolete project/runtime responses cannot publish to a new selection.

`ReadAttentionFollowUpAsync` admits only current typed get/decision-show/work-check/work-status/pending-list and exact `find --all --scope <scope> --kind knowledge` inventory argument shapes after rechecking project/runtime binding. Inventory scopes come from the fresh verified current and historical project mapping. The read chooser exposes those same mapped scopes, including full reads for omitted historical intents. An unrelated scope remains rejected even when an attention response advertises it. Reading details leaves the attention snapshot unchanged. No response prose is executed.

## Observed identity

The Connection readout distinguishes reported release, capability metadata, contract/schema support, runtime generation/fingerprint, observed core SHA-256 digest and its `verified_manifest_core` or `source_inventory` basis, actual Loader assembly informational version and SHA-256, and last-observed database instance/epoch/revision. Manifest core verification covers those entries only. Source inventory observes source bytes and leaves packaged payload unverified. Loader manifest entry, installer/signature/publication provenance and installed hooks are explicitly not checked; equal release labels do not establish equal payloads.

Namespace: `Lodestar.Loader`. Files: `Models/OperatorReadouts.cs`, `Services/ReadableRecord.cs`, `Services/LodestarHealth.cs`.

## Record inspector

`ReadableRecord.Project(LibraryRecord record) -> OperatorRecordReadout`

- `Headline`, `KindLabel`, `State`, `Summary` are deterministic labels from the stored record. `State` says `Recorded status/lifecycle/availability` or `No status recorded`; it never indicates a live worker.
- `Sections` contains `ReadoutSection(Heading, Items)`. Each `ReadoutNode` has `Path` (RFC 6901-style pointer relative to the record root), `Label`, `Value`, `Type`, `Children`, and `Truncated`. Section headings vary by record kind for project, note, fact, knowledge, work, handoff, decision, pending, and rejection. Nested unknown fields remain in the tree, with other top-level fields under `Other stored fields`.
- `RawJson` is the full pretty-printed stored record. `Truncated` and `LimitNotice` state when the tree hits 300 nodes, six nested levels, or 800 scalar characters. The raw view is the complete fallback.
- A missing `data` field gets an explicit `missing` node. Present JSON `null`, `false`, and `0` render distinctly and retain their types.

## Health view

`LodestarHealth.Build(LibrarySnapshot? library, CapabilitySnapshot? capabilities, IReadOnlyList<PendingSave>? pendingSaves, CliResult? doctor = null) -> LodestarHealthSnapshot`

The method only projects supplied results. It does no CLI call, database access, timer, filesystem scan, or PC telemetry. Pass `service.PendingSaves()` when that journal read was performed; pass `null` when it was not. The `doctor` argument should be an explicitly requested `service.RunReadAsync()` result for the described `doctor` read operation. Missing doctor input yields `Store integrity: Not checked`.

`Observations` are rows of `HealthObservation(Label, Value, State, Detail)`. States are `ok`, `attention`, `observed`, or `unknown`; a status of `observed` is not a health pass. `Issues` are `HealthIssue(Message, ActionKey)`. Supported action keys are `refresh`, `doctor`, `pending-saves`, `connection`, and `record-errors`; they are UI routing hints, never shell commands. The view must decide whether and how to execute them. `Headline` and `State` summarize the supplied observations without a score.

Doctor data is accepted only from a successful CLI envelope whose operation is `doctor`. The projection reads doctor `healthy`, `database_revision`, `schema_version`, `checks`, and `issues`. It rejects a doctor result whose store instance or epoch conflicts with the loaded library. A doctor result describes its observed moment; the view should show the explicit check action and avoid treating it as continuous monitoring.
