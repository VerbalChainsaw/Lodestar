# Lodestar native Codex adapter

This optional adapter supplies Codex startup context, host-bound work
and handoff tools, pending-note capture, and opt-in compaction continuity. It uses
the separately installed Lodestar core through that core's maintained transport.

The adapter and core have independent versions. Adapter 1.4.7 targets Lodestar
core 3.0.1. CI qualifies the native archive against the exact packed core from
the same source revision on Windows. The core package's optional generic MCP plugin does
not provide these native hooks; replacing this adapter with it would remove
native continuity capabilities. Enable one Lodestar plugin for this host.

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

Version 1.4.7 adds bounded JSON/protocol admission, decimal and duplicate-key
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

Compaction continuity remains opt-in for an exact project and session through
`.omx/lodestar-compaction.json`. Installing the adapter does not activate that
binding. Synthetic hook tests do not establish natural Desktop PreCompact event
delivery.

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
node scripts/smoke-native-codex.mjs <output-directory>/lodestar-native-codex-1.4.7.tgz <packed-core-directory>/lodestar.mjs
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
