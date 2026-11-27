# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 3.0 source | Current development and security review |
| 2.x | Published line; use its latest available patch |
| 1.x and earlier | No |

Report the exact source or installed version and platform. Development-source
repairs do not establish that an older installation contains those repairs.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/VerbalChainsaw/Lodestar/security/advisories/new)
for an undisclosed issue. Include the affected version and platform, smallest
reproduction, required attacker capabilities, impact, and suggested mitigation.

## Security boundary

Lodestar is an offline, single-user local registry. It has no runtime network
requirement, daemon, telemetry, hook service, App Server integration, plugin loader,
or background process. Its optional MCP adapter invokes the same installed one-shot
package and owns no database, receipt cache, or authority policy.

The SQLite database is not encrypted, signed, authenticated, or an authorization
boundary. A process that can read or replace the file can read or replace its records.
Protect it with operating-system permissions and tested backups.

Normal INSERT, UPDATE, and DELETE operations on state tables require a
connection-scoped contract-5 admission guard and run inside an immediate transaction
with foreign keys and full synchronous mode. Outside admission, `trusted_schema=OFF`
rejects the trigger's application function; if trusted schema is enabled, that
function returns zero and the trigger aborts the row write. Requests
bind the database instance, recovery epoch, target revisions, applicability, and full
payload to an idempotent receipt. These controls protect normal concurrency, retries,
and retained old clients. They do not defend against deliberate SQLite page rewriting,
faulty storage, or total loss of uncommitted external task context. The row triggers
do not restrict schema changes such as DROP TABLE. Code holding a SQLite connection
is trusted to issue fixed internal schema and migration SQL. A file-owning external
SQLite client can read the data and schema; the store is not a sandbox for that client.

CLI mutation bodies and JSON argument transports have a 16 MiB UTF-8 byte limit,
including whitespace and an optional BOM. File inputs are checked before reading
and while streaming; stdin is checked incrementally before copying each chunk.
An overflow returns `resource_limit` before JSON parsing or dispatch, with the
observed bytes, maximum, resource, and a reduce-input recovery action. The complete
oversized request is neither retained by the reader nor silently truncated.

The MCP adapter enforces the same 16 MiB frame and child-input limit, including
request metadata. An oversized frame produces a descriptive error and is discarded
through its newline; the next complete frame remains readable. Child responses
share Manager's two-channel envelope validation, 30-second deadline and 64 MiB combined
output budget. Incomplete or contradictory mutation responses are unknown outcomes,
with instructions to reconcile and replay the exact original client request.
Successful mutation responses must match the request, store, epoch, receipt and
committed revision. This confirms a protocol result, not authenticity against a
malicious file owner who can replace the executable or database.
Replies wait for output completion so a slow reader cannot create an unchecked
response queue. A closed response channel ends the adapter with bounded local
stderr guidance; a prior write's outcome must be reconciled by the client.
An explicit rejection describes the current attempt; it does not prove an earlier
attempt with a lost response never committed.

Record content and source metadata may contain sensitive information. The package does
not redact arbitrary user records. Keep private exports and backups under appropriate
filesystem permissions. Native tool adapters must not invent actor or user attribution;
identity-required mutations fail when authenticated host evidence is unavailable.
