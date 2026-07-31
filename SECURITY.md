# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| 0.x | No |

Use the latest published 1.x patch before reporting behavior that may already
be fixed.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/VerbalChainsaw/Lodestar/security/advisories/new)
and include the affected version and platform, the smallest reproduction,
required attacker capabilities, impact, and any suggested mitigation.

## Security boundary

Lodestar is an offline, single-user local registry. It has no runtime network
requirement, service, telemetry, plugin loader, provider adapter, or background
process.

The SQLite database is not encrypted, signed, authenticated, or an
authorization boundary. Scope values organize context; they do not restrict
access. A process able to read or replace the database can read or replace its
knowledge. Protect the file with operating-system permissions and tested
backup practices suitable for its contents.

Writes use SQLite transactions, foreign keys, rollback journaling, and full
synchronous mode. These protect normal commits and interrupted transactions;
they do not defend against malicious file replacement, faulty storage, or
loss. New targets are reserved with no-replace file creation and restrictive
POSIX permissions before SQLite initialization. Published reservations are
never removed as failure cleanup because another process may have completed
the visible path; zero-byte reservations are resumable. Inputs, diagnostics,
and migration details are bounded, including hostile in-process stream and
error objects. `lodestar doctor` detects supported schema, referential,
complete stored-semantic, ownership-limit, and SQLite integrity problems but
does not repair them. If SQLite cannot confirm a transaction's commit outcome,
Lodestar reports `database_commit_outcome_unknown` and preserves a newly
initialized database for read-only diagnosis instead of deleting evidence.

The legacy importer opens source files read-only, rejects symlinks in accepted
paths, confines reads to the selected store, verifies a present integrity
manifest, fingerprints accepted inputs, and rejects a destination inside the
source tree. An existing destination with more than one hard link is also
rejected so it cannot alias a source file through another path. The importer
rolls back when transaction state proves a pre-commit failure and preserves a
new destination when the outcome genuinely cannot be confirmed. Keep an
independent copy of legacy data until migration has been validated, including
the report's emitted and omitted-entry counts.
