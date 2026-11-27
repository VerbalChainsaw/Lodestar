# Lodestar native Codex adapter

This optional adapter supplies a Codex startup routing hint, host-bound work
and handoff tools, pending-note capture, and opt-in compaction continuity. It uses
the separately installed Lodestar core through that core's maintained transport.

The adapter and core have independent versions. Adapter 1.4.10 targets Lodestar
core 3.0.5. CI qualifies the native archive against the exact packed core from
the same source revision on Windows. The core package's optional generic MCP plugin does
not provide these native hooks; replacing this adapter with it would remove
native continuity capabilities. Enable one Lodestar plugin for this host. The
native adapter exposes both host-attested work/handoff tools and the selected
core's checked describe, read, and mutate tools through the same server.

Normal startup (and compaction with no matching binding) never reads the core
database. For substantive project work, follow the current project instructions
and use one scoped orientation or an exact work/handoff read as relevant. A
startup hint alone does not establish verified use or a write basis.

### What each hook should do

| Hook | Use it for | Routine cost |
| --- | --- | --- |
| SessionStart | Give one short routing hint. On resume with an explicit matching checkout/session binding, surface that exact current work record and its stored next action. After compact, recover the exact bound work, not a transcript. | No project database read on ordinary startup or unbound resume. Exact resume is read-only and fails open with a retry pointer. |
| UserPromptSubmit | Keep exact handoff command authorization; recover a pending compact checkpoint once if the compact-start event did not deliver it. | No routine project database call or raw message capture. |
| PreToolUse | Bind the existing continuity tool call to its real session, turn, checkout and arguments. | Only matches named Lodestar tools; no project database mutation. |
| PreCompact | Save one checked checkpoint for a changed semantic work projection, only with an exact opt-in binding. | No database call when unbound; no new receipt when unchanged. |
| Stop | Keep the explicit pending-note opt-in. Pre-existing or quoted marker text is not proof that a note belongs in the ledger. | No database call without an explicit note marker. No transcript tail capture. |

For substantive work or a resume, read the existing exact work/handoff record
once. At a material decision, verified milestone, blocker, handoff, or final
completion, update the existing record with the change, evidence and next
action. Read the checked write basis and verify the receipt. No automatic
status writes for ordinary turns, repeated narration or unchanged state.
Prefer a short evidence locator or digest to copied dialogue. A pending note
is for review; it is not authoritative project status.

Compaction writes a content-free local pending marker for the bound session.
A successful compact-start recovery normally clears it. If that delivery is
missed, the next prompt in the same session checks the marker and performs
the same bounded, read-only recovery. Failed reads leave it available for
retry. The marker does not establish whether a model subsequently acted on
the advice; verify that independently from the tool read and resulting work.

## Runtime selection

The adapter carries the discovered Node executable and package entry through to
every core invocation. Explicit `LODESTAR_NODE` and `LODESTAR_ENTRY` selections
remain supported. On Windows, discovery searches installed Node runtimes under
the user's `.local/opt` directory. The Node process used to start Codex hooks may
be different; it must not silently replace the selected core runtime.

Version 1.4.6 repaired that handoff. Earlier adapters could locate the intended
package but execute it with the hook's Node process, producing an incorrect
launcher-repair warning during startup.

Automatic discovery is qualified on Windows. On other systems the current native
adapter requires explicit paired `LODESTAR_NODE` and `LODESTAR_ENTRY` overrides;
Linux/macOS host acceptance is not established by the Windows checks. The
separate generic MCP plugin retains its own supported Windows/WSL routing.

Version 1.4.8 changes startup to a routing hint without loading project records.
Version 1.4.7 added bounded JSON/protocol admission, decimal and duplicate-key
validation, hook failure handling, and qualification of the complete independent
plugin archive. Its skill payload is generated from the core repository's
canonical managed Lodestar skill; do not edit the generated copy here.

## Installation and state

For an existing `personal` installation, point its existing `lodestar` source
entry at this complete native directory. Install or upgrade using
`codex plugin add lodestar@personal --json`. Keep the same plugin
identity and preserve its data directory, including pending requests and
attestations. Do not remove the plugin or clear its data as an upgrade step.

For a new installation, extract the verified native archive to a durable local
directory or use this directory in a maintained Git checkout. The directory
containing `.agents/plugins/marketplace.json` is the native marketplace root:

```text
codex plugin marketplace add "<absolute-native-directory>"
codex plugin add lodestar@lodestar-native --json
```

Use the existing identity for an upgrade; switching to `lodestar-native` is not
an upgrade procedure for a `personal` installation. Keep one active Lodestar
plugin. Install/select the shared Lodestar core separately. The native archive
does not bundle a core, a database, credentials or plugin data.

Restart Codex after an upgrade to load the new MCP server process. Hook scripts
and the selected core are also checked directly during installation validation.

Resume and compaction continuity require an explicit existing
`.omx/lodestar-compaction.json` in the checkout. Set version `1`, the exact
absolute `project_root`, the real Codex `session_id`, and an existing checked
`intent_record_id`. If you use a disposable database, its optional absolute
`database` must be inside that checkout. Installing the adapter does not create
or activate a binding. Do not guess the session or choose an unrelated intent.

On a normal resume, the hook performs one read of that exact intent, with a
five-second core-call budget. It supplies the stored objective and next action,
not new permissions or proof. If the binding or store is unavailable, the turn
continues and tells the operator what to check. If the complete card will not
fit the hook delivery budget, it gives the complete-read pointer instead of
silently trimming the card. There is no receipt write; ordinary starts and
wrong-session resumes do not read the core.

Codex may require the owner to review changed hooks in Settings → Hooks
(or `/hooks` in the CLI). The tests below run the real hook executable and
disposable core, not natural hook delivery by an already running Desktop app.

## Verification

Set `LODESTAR_ENTRY` to the installed core's `lodestar.mjs` and `LODESTAR_NODE`
to its Node executable, then run `node --test tests/*.test.mjs` from this native
directory. The lifecycle integration tests use disposable databases and exercise
authorization, exact replay, stale-write refusal, session isolation, redaction,
and handoff recovery. Runtime-selection coverage checks the executable actually
used across the adapter/transport boundary.

From the repository root, build a separate native archive and test its extracted
payload against an already installed, exact candidate core:

```text
node scripts/build-native-codex.mjs <new-output-directory>
node scripts/smoke-native-codex.mjs <output-directory>/lodestar-native-codex-1.4.10.tgz <packed-core-directory>/lodestar.mjs
```

The builder writes the archive and `SHA256SUMS`, refuses existing output artifacts,
and verifies both generated skill copies. The smoke verifies the checksum,
extracts an isolated cache, initializes MCP and runs the included tests against
the selected core. Node.js 24.15.0 or newer and `tar` are required for these build
and qualification commands. Native archive contents remain outside the core npm
payload. Release records must identify both native archive checksum and core
artifact checksum/version; a GitHub source push alone is not a published release.

Windows installation qualification does
not establish fresh Linux or macOS host acceptance.
