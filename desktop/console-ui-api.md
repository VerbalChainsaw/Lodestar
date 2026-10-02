# Operator console UI handoff (R05)

> Historical lane snapshot, 2026-09-28, labeled 2026-10-02. The connected
> acceptance actions and pending claims below retain the original checkpoint.
> Current product guidance is in [the documentation index](../docs/README.md);
> current delivery disposition is in [the release record](../../../outputs/RELEASE-PLAN.md).
> Control descriptions remain references; original lane verification is history.

## Source direction

THESIS: A native Lodestar workstation makes recorded state legible and correctable in one dense window. OWN-WORLD: Graphite panes, precise hairlines, restrained mint action color, system Segoe UI, and familiar Windows controls. STORY: Check the observed store, locate a project, inspect provenance, review a correction, then save deliberately. FIRST VIEWPORT: A 44px command bar, narrow resizable project rail, compact Health observations and issues, and a 24px status line. FORM: Virtualized column tables, short toolbars, resizable contextual inspector, labeled fields, readable nested sections, and exact raw/history access. FINISH: Keyboard focus and high contrast remain visible; unknown health stays unknown; no decorative charts or invented metrics.

## C4 baseline and route

The accepted Codeplan selects the existing WPF/public-CLI mechanism. Pre-edit source has `_generation` checks for async reads, `CanLeaveDraft` before navigation, reviewed frozen save requests, and queued approved close cleanup. The wide inspector is always 410px and is reset on resize; selection handling is `ListBox`-specific. This lane changes presentation and keeps those lifecycle guards. The C4 falsifier remains a newer draft overwritten by selection/refresh/grouping/resize, an unreviewed save, or an owned child left at close. Coordinator will run connected UI checks after integration.

## Control contract

Existing IDs remain for `ProjectList`, `ProjectDashboard`, `RecordList`, `MainTabs`, `LibrarySearch`, `EditRecord`, `EditName`, `EditAvailability`, `EditPriority`, `EditData`, `ReviewEdit`, `SaveEdit`, `RunCommand`, and `ReplayPending`.

| Area | New AutomationIds | Behavior |
| --- | --- | --- |
| Health | `HealthNavigation`, `RunHealthCheck`, `HealthObservations`, `HealthIssues`, `HealthActivity`, `HealthAction_<key>_<index>` | Default workspace; doctor only runs on explicit action. Issue keys route to fixed UI actions. |
| Library | `ContinueLibrary`, `RecordsNavigation`, `ProjectGroup`, `ResetProjectView`, `RecordSort`, `RecordGroup`, `ResetRecordView` | Continue appears for a validated resumable partial snapshot; table headers sort typed dates/counts. |
| Layout | `NavigationSplitter`, `InspectorSplitter`, `CollapseInspector`, `ResetInspector`, `OpenInspector`, `InspectorBack` | Native splitter keyboard arrows resize. The inspector is absent without selected content and switches to a full workspace view below 1180 DIP. |
| Inspector | `ReadableContent`, `ReadableRecord`, `RecordRaw`, `RecordHistory`, `DiscardEdit`, `EditScalar_status`, `EditScalar_summary`, `EditScalar_description`, `EditScalar_notes` | Scalar IDs appear only for existing string fields. Advanced JSON is the single draft data buffer. |
| Narrow command/connection | `RunCommandInspector`, `ReplayPendingInspector`, `RefreshCapabilitiesTop`, `SelectRuntimeTop` | Mirrors actions that would otherwise be hidden behind the narrow inspector. Dynamic inputs use `CommandInput_<name>`. |

Keyboard: `Ctrl+F` finder; `F5` refresh; `Ctrl+S` Review then Save while editing; `Escape` handles draft exit or compact Back; `Ctrl+Alt+Left` collapses the inspector; `Ctrl+Alt+0` resets its preferred width. Splitter arrow keys provide resize, subject to native WPF focus behavior.

## Test and capture assumptions

`ProjectDashboard`, `OverviewRecords`, and `RecordList` are read-only `DataGrid` controls; automation should use grid row/cell patterns instead of `ListBoxItem`. `ProjectList` and the special/work/activity lists remain `ListBox`. The startup smoke method now captures `health` at 1440×900, 1100×750, and 900×600 before the earlier library sequence. It does not run doctor or submit a mutation. At 900 DIP, selecting a record replaces the main workspace until Back; Back preserves a draft and `OpenInspector` restores it. The coordinator owns connected screenshots, interaction fixtures, and the test-runner traversal update.

## Lane verification and error register

- 2026-09-28 UTC, first XAML-stage `dotnet build --no-restore`: 16 errors, all expected missing code-behind handlers and the old mixed ListBox template array; resolved by adding handlers and removing converted grids from that array.
- 2026-09-28 UTC, five `apply_patch` attempts failed before mutation: a combined delete/add of `App.xaml`, a stale history-method anchor, a health-button XAML anchor, a command-input line targeted to the wrong partial file, and a project-sort XAML anchor. Each was retried with the actual owner/line; no source was reverted.
- 2026-09-28 UTC, final no-restore WPF build `f62f1c` completed with 0 warnings and 0 errors. This proves compilation only. Rendered states, keyboard interaction, high contrast, doctor dispatch, and safe save/close behavior still require the coordinator's connected acceptance pass.
