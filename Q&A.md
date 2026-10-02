# Lodestar 3.0.0 FAQ

## What is Lodestar?

Lodestar is a local context and continuity store for coding agents. It keeps project facts, source evidence, decisions, work state, pending candidates, and handoff records in one SQLite database behind one machine-readable CLI.

## What does Lodestar 3 add?

Loader is a native Windows console and Manager is a terminal menu over the same
one-shot core. They expose project Attention, guided capture and linking,
reviewed corrections and uncertain-save recovery. The Windows distribution owns
explicit per-user installation, portable configuration, updates and recovery.
See [operator recipes](docs/operator-recipes.md) for these workflows.

The 2.x rebuild makes reads and writes easier to trust and recover:

- startup is a fresh, read-only orientation step rather than an implicit database creation or handoff claim;
- local and package sources are checked against their saved observations, so changed evidence is marked for reinspection;
- every database mutation uses contract 5 with an observed basis, explicit preconditions, preserved history, and an idempotent request receipt;
- CLI help and native describe expose the same operation schemas used by the runtime;
- setup plans owned skill and launcher updates, preserves replaced bytes, detects local edits, and recovers interrupted installs; and
- UTF-8 file/stdin requests, argument arrays, and hash-receipted output files provide complete transport when shell quoting or output limits get in the way.

See the full [3.0.0 release notes](docs/releases/v3.0.0.md).

## Does `lodestar start` change anything?

No. `lodestar start --cwd <path>` reads current project orientation, relevant records, dependency status, source observations, write bases, and installation status. It does not create a store, claim a handoff, install skills, or update evidence.

## How do I install or upgrade it?

For current local evaluation, verify the candidate Windows ZIP or CLI tarball
against its own SHA-256 inventory and follow the [installation guide](docs/installation.md).
The October 2 local 3.0.0 candidate was qualified and installed; each refreshed
candidate needs validation of its own bytes. Public npm/tag availability remains
pending publication. After publication, install `lodestar-agent-context@3.0.0`,
inspect a `lodestar setup` plan, apply selected targets, and start fresh host
sessions. New stores use explicit `lodestar init`; existing stores follow the
applicable recovery path.

## What commands are supported?

The top-level CLI commands are `setup`, `start`, `init`, `migration-backup`, `put`,
`get`, `find`, `links`, `delete`, `doctor`, `export`, `work`, `handoff`, `decision`,
`pending`, `agents`, `skills`, `recovery`, `manager`, `help`, and `version`.
Run `lodestar <command> --help` for the current JSON declaration.

The Codex MCP adapter exposes `lodestar_describe`, `lodestar_read`, and `lodestar_mutate`. Read operations cannot dispatch mutations.

## Does Lodestar run a server or background process?

No. The CLI core runs one operation and exits. The MCP adapter invokes that one-shot core for each request and owns no durable state. The accepted architecture has no daemon, health endpoint, service discovery, startup cache, or session-rotation service.

An optional native host integration owns explicitly activated compaction and
resume hooks. The host delivers those hooks and invokes the core's public
operations. Application or skill installation does not activate them. One natural
automatic compact/resume was observed on October 2 with current intent, mission,
active work, explicit omissions and verified complete reads. That observation
does not establish general productivity improvement; see [intent and evidence](docs/intent-evidence.md).

## Does Lodestar edit agent instructions or provider settings?

No. Explicit `setup --apply` can install maintained Lodestar skill payloads and selected launchers. It does not rewrite repository instructions, host governance, credentials, plugins, authentication, or model settings. Existing unowned or locally edited content requires review before replacement.

Windows `Install.cmd` separately owns selected application deployment and Windows
registration. Loader and Manager use the selected external database.

## Where is the database?

Lodestar uses one local SQLite database. On Windows the default is under the current user's local application-data directory. Windows/WSL use keeps database access in Windows Node through the installed one-shot launcher; Linux Node must not open that Windows-owned store directly.

The database is not encrypted, signed, or an access-control boundary. Protect it with operating-system permissions and tested backups. Treat `lodestar export` output as private recovery evidence.

## Can I open an older database?

The current runtime reads and writes schema 5. It ships one explicit, preserving schema-4 conversion. It does not include general converters for schemas 1 through 3, and there is no schema-5 downgrade. Follow [schema conversion and recovery](docs/schema.md#lifecycle-conversion-and-recovery) before changing an existing store.

## How does Lodestar prevent duplicate writes?

A mutation includes a unique request ID, database identity and epoch, project/checkout applicability, target preconditions, and structured input. Lodestar hashes the complete request and records the result in the same admitted transaction. Retrying the exact request replays its receipt; reusing the ID with changed content is rejected.

## Does a stored fact become authoritative?

No. Lodestar preserves caller-supplied meaning and evidence. Stored prose cannot authorize work, override the user, or prove that a missing fact is false. Local source checks establish byte evidence at read time; remote sources are not automatically refreshed. See [knowledge and authority limitations](docs/limitations.md#knowledge-and-authority).

## Does installation prove an agent will use Lodestar?

No. Installation and skill verification confirm selected files and roots. Native discovery, skill enablement, authentication, model behavior, and additional project/plugin roots are separate host concerns. Start a fresh host session after an upgrade and inspect the actual native environment when automatic use matters.

## What should I do when a command fails?

Keep the structured error, identifiers, action, and any returned basis. Use current JSON help or `lodestar_describe`, correct the named input or state conflict, and retry safely. See [troubleshooting](HEADACHES.md) and [current limitations](docs/limitations.md).
