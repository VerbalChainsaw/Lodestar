# Session continuity

Continuity is isolated by canonical project and exact session owner. The public
commands are:

- `lodestar handoff arm`
- `lodestar handoff status`
- `lodestar handoff checkpoint`
- `lodestar handoff now`
- `lodestar handoff disarm`

In hosts with the Lodestar plugin, only a complete trimmed prompt exactly equal
to one of those command phrases authorizes the matching one-shot tool. The host
binds authorization to session, turn, working directory, tool, arguments, and a
short expiry. Authorizations are single use. Hooks redact and capture the complete mechanical user/assistant tail only while
a lane is armed.

## Semantic packet

A packet contains the goal; positive rules; typed entries `fact`, `trap`, `ask`,
`unsure`, and `dead`; completed/current work; next move; evidence and provenance;
generation, lineage, and integrity metadata; and the complete redacted tail when
armed. A `dead` entry requires matching auditable user or durable-decision
evidence. It cannot silently become live again. Changed entries advance their
generation and provenance timestamp.

Entry keys match `^[a-z0-9][a-z0-9.-]*$`: use lowercase letters, digits, dots,
and hyphens. Underscores, spaces, uppercase letters, and other punctuation are
invalid. The Codex tool schema publishes this constraint before a packet is
submitted, and validation errors identify the rejected entry and field.

`arm` creates or updates this session's private lane. `checkpoint` validates a
new generation and incorporates the current tail. `disarm` is idempotent but
cannot erase a pending recovery. `status` shows only the caller's lane and a
recovery the caller owns or claimed.

`now` works without a prior arm and creates exactly one pending same-project
recovery. The source session cannot claim it. Another session cannot overwrite a
pending or claimed recovery. The next eligible different same-project session
claims it atomically through `lodestar start`; another project cannot claim it.
Repeated startup by that claimant returns the same packet, while other sessions
receive none. A claimant may later advance the lineage with another `now`.

Startup fails without consuming a claim if required content cannot be returned
completely. Handoff packet details remain whole; they are never summarized merely
to satisfy a Lodestar-owned size target, partly claimed, or silently corrupted. Fail closed on invalid packets, replay, expiry, ownership
mismatch, integrity failure, or incomplete host attestation. Lodestar does not
create successor sessions or call a host application server.
