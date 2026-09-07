# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 2.x | Yes |
| 1.x and earlier | No |

Before publication, verify the supplied `lodestar-agent-context-2.0.0.tgz` artifact.
After a 2.x release is published, use the latest published patch before reporting
behavior that may already be fixed.

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

All state-table writes require a connection-scoped contract-5 admission guard and run
inside an immediate transaction with foreign keys and full synchronous mode. Requests
bind the database instance, recovery epoch, target revisions, applicability, and full
payload to an idempotent receipt. These controls protect normal concurrency, retries,
and retained old clients. They do not defend against deliberate SQLite page rewriting,
faulty storage, or total loss of uncommitted external task context.

Record content and source metadata may contain sensitive information. The package does
not redact arbitrary user records. Keep private exports and backups under appropriate
filesystem permissions. Native tool adapters must not invent actor or user attribution;
identity-required mutations fail when authenticated host evidence is unavailable.
