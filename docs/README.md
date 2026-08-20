# Lodestar implementation contract

Lodestar is one local product and brand. It owns agent startup projection,
scoped knowledge, advisory work presence, session continuity, durable project
decisions, and managed governance assets.

The accepted topology is deliberately small:

- one `lodestar` executable;
- one Windows-owned SQLite database;
- one schema and migration path;
- one versioned JSON success/error envelope;
- one Lodestar package per supported host, containing only thin hooks,
  recognition, redaction, attestation, and one-shot CLI bridging;
- no runtime network dependency, daemon, discovery service, or background
  indexer; and
- no direct WSL access to SQLite.

Normalized record kinds share the same database, revision allocator,
transaction boundary, integrity checks, and backup policy. Hosts do not own or
mirror Lodestar state.

## Public surface

```text
lodestar start
lodestar init
lodestar put
lodestar get
lodestar find
lodestar links
lodestar delete
lodestar import
lodestar export
lodestar work ...
lodestar handoff ...
lodestar decision ...
lodestar skills ...
lodestar agents ...
lodestar doctor
```

Every successful operation emits a version-1 JSON envelope. Errors use the same
envelope shape with a stable code, bounded diagnostic fields, and a recovery
action. Help and version are side-effect free.

## Startup projection

`lodestar start --cwd <cwd>` resolves the canonical project and returns, in
deterministic order:

1. project identity;
2. required global and project governance;
3. current decision facts and superseded dead values;
4. every optional knowledge record unless the caller explicitly targets optional projection size;
5. advisory active-work reports; and
6. an eligible continuity recovery, if one exists.

Without a caller target, the envelope contains all optional knowledge. With an
explicit positive `--startup-budget`, whole optional records are included in
deterministic order and omitted records remain addressable by stable-ID stubs.
Required governance, decisions, and handoff state are never shed or truncated.
Claiming a pending recovery and returning startup state are one transaction; any
failed transaction leaves the recovery unclaimed.

## Knowledge

Exact ID or alias lookup precedes deterministic search. IDs, aliases, explicit links,
scope, and provenance are stable and deterministic. A missing record means only
that Lodestar lacks the knowledge; callers may then inspect the repository.
`find` returns matching records, optionally using a caller-selected positive page size; `links` returns one explicit hop.

## Advisory work presence

`lodestar work status|start|done|history|expire` stores peer-reported activity.
It is never an assignment, ownership claim, lock, authority, or proof an area is
free. Project/worktree and actor/session identities are canonical. An actor has
at most one open report; repeated start updates it and repeated done is a safe
no-op. Status and history ordering are deterministic. `STALE?` is not evidence
that work was abandoned, and expiration is explicit, auditable, and limited to qualifying advisory records.

## Session continuity

The continuity surface is:

```text
lodestar handoff arm
lodestar handoff status
lodestar handoff checkpoint
lodestar handoff now
lodestar handoff disarm
```

Semantic packets contain a goal, positive rules, typed `fact`, `trap`, `ask`,
`unsure`, and `dead` entries, completed/current work, a next move, evidence and
provenance, generation/lineage/integrity metadata, and the complete redacted tail
when armed. Dead entries require matching auditable evidence and cannot silently
resurrect.

Lanes are isolated by canonical project and exact source session. `now` works
without prior arming and creates exactly one pending same-project recovery. The
source cannot claim it, another project cannot claim it, and another session
cannot overwrite it. The next eligible different same-project session claims it
atomically at startup; retries by that claimant return the same packet.

Host adapters authorize only exact commands, bind short-lived attestations to
the relevant session and arguments, redact, and invoke Lodestar once. Lodestar
does not create successor sessions.

## Durable decisions

```text
lodestar decision set <key> <value> [--reason <text>]
lodestar decision drop <key> [--reason <text>]
lodestar decision show
lodestar decision inject on|off [--reason <text>]
```

Events are append-only per canonical project. Current and dead values are
derived from history. A dropped key has no current value. For `A -> B -> A`, the
final `A` is current and does not also appear as dead; `B` remains dead. Startup
renders deterministic FACTS and DEAD sections unless projection is explicitly
disabled. Decisions reject secrets and are not a place for brainstorms,
temporary work, personal data, raw logs, TODOs, or commit IDs.

## Managed package and bootstrap

Lodestar manages exactly these skills:

- `director-protocol`
- `codeplan`
- `center-multigeometry`
- `center-audit`
- `ladder-audit`
- `lodestar`

The Lodestar umbrella skill routes knowledge, work, continuity, decisions,
bootstrap behavior, failure rules, templates, and governance guidance through
owned references. Specialized skill names describe capabilities, not products.
`managed-assets/manifest.json`, canonical governance/bootstrap JSON, and the six
managed skill directories are runtime and packaging authority. The asset check
verifies the exact directory set, canonical documentation views, and Codex mirror
without a semantic policy compiler.

Every integration receives the same compact redirect: obtain and apply one complete
validated startup snapshot. Failed or clipped raw attempts remain retryable with the
same session identity and replay the same persisted snapshot.

External skill directories and AGENTS.md files are outside Lodestar's ownership.
`lodestar skills verify` compares existing skill copies with package source, while
`lodestar agents status|verify|template` inspects or prints source. These commands are
read-only and cannot install, synchronize, apply, replace, migrate, back up, or remove
external files.

## Migration

`lodestar import` accepts either a direct v0.7 knowledge store or a version-1
JSON manifest whose sources use these kinds:

```text
knowledge-v070
work-sqlite
decision-jsonl
continuity-json
lodestar-sqlite
```

The manifest importer fingerprints sources, creates a timestamped destination
backup, imports within one transaction, verifies source and imported identity,
runs integrity checks, and writes deterministic migration-source records.
Rerunning the same manifest does not duplicate records, events, lanes, packets,
claims, or work reports. Sources remain untouched for separately authorized
archival or deletion.

## AgentLink boundary

AgentLink may validate a request, invoke the configured `lodestar` executable,
parse the complete versioned envelope, apply an explicitly configured real host
boundary when one exists, redact failure text, and return the result. It must not implement Lodestar semantics or access the
Lodestar database. Its unrelated task-supervision database remains outside this
boundary.

## Verification

```text
npm run assets:check
npm test
npm run pack:check
```

The tests cover the one-database invariant, Windows/WSL identity, advisory work,
decision history and resurrection suppression, exact-command continuity,
session/project isolation, atomic startup claiming, complete startup replay,
managed-asset parity, installation rollback, migration idempotency, packaging,
and real one-shot adapter behavior.
