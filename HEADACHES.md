# Troubleshooting Lodestar 2.1.2

This page covers the current release. Start with the [installation guide](docs/installation.md), then use the matching recovery path below. `lodestar doctor` reports problems; it does not repair the database.

## `lodestar` is missing or reports the wrong version

Install the current package, open a new shell, and confirm the executable:

```text
npm install --global lodestar-agent-context@2.1.2
lodestar --version
```

If a Git Bash or WSL launcher still points to an older Node or package location, rerun the selected `lodestar setup` plan and apply it. See [Windows and WSL installation](docs/installation.md#windows-and-wsl).

## No database exists

Run `lodestar init` only to create a new schema-5 store. Do not initialize over an existing store. A schema-4 store requires the inspected conversion and verified backup described in [schema conversion and recovery](docs/schema.md#lifecycle-conversion-and-recovery).

## Setup reports local content or a conflict

First inspect the read-only plan:

```text
lodestar setup --target all
```

Unchanged Lodestar-owned copies upgrade from their installation receipts. Existing content without a matching receipt must be reviewed before using `--replace-local`; replaced bytes are retained. After an interrupted setup, repeat the same command so recovery can settle or report the preserved conflict. An `install_busy` result means another live installer or unresolved lock owns that directory.

## Skill verification fails

```text
lodestar skills verify --target all
```

Inspect the roots returned in the response. Verification covers those selected roots, not every project or plugin directory a host may discover. Native hosts can also reject duplicate skill names or retain already-loaded instructions. Resolve the owning duplicate or stale instruction, then start a fresh host session. See [homes and discovery](docs/installation.md#homes-and-discovery).

## Startup reports incomplete or stale context

Run startup against the intended checkout:

```text
lodestar start --cwd .
```

Inspect `complete`, record errors, project identity, selected installation roots, and source observations. `needs_reinspection` means the current local or package source changed, disappeared, became unreadable, or could not be read stably against its saved observation. Re-read the source and use the returned write basis for any correction. Missing optional context does not block unrelated work whose required inputs are complete.

If the host clips output, use `--output <new-file>` and verify the returned byte count and SHA-256 before relying on the file. Complete argument arrays can be supplied through `--args-file` or `--args-stdin`; see [complete input and output](docs/installation.md#complete-input-and-output).

## A mutation is rejected

Use `lodestar <command> --help` in JSON mode, or native `lodestar_describe`, for the current input schema. Read the target again, keep the complete returned basis, and submit a new request against that basis. If the response was lost after commit, retry the exact same request ID and payload; Lodestar replays the stored receipt instead of applying the change twice.

Do not reuse a request ID with changed content. Do not guess missing fields, revisions, database instance IDs, or epochs. See the [contract-5 mutation model](docs/schema.md#mutation-contract).

## `doctor` reports database damage

Run `lodestar doctor` and preserve the exact report. Restore a verified external backup or follow the explicit recovery procedure; do not edit SQLite rows by hand or treat `doctor` as an automatic repair tool. See [storage and recovery limits](docs/limitations.md#storage-and-transactions).

## WSL reaches the wrong project or database

Use the installed one-shot WSL launcher. It invokes Windows Node, forwards the actual working directory, and keeps the SQLite database on the Windows side. Rerun setup when Node or the package moves. Do not open the Lodestar database directly with Linux Node. See [Windows and WSL](docs/installation.md#windows-and-wsl).
