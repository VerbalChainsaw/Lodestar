# Durable decisions

## Marker grammar (one grammar for every marker)

A marker is a bracketed tag with ordered attributes: `[KIND attr=value ...]`.
One definition (`src/markers.mjs`) formats projections and parses capture, so
display, storage, capture, and documentation cannot drift.

- Kinds: `DECISION`, `DEAD`, `SUPERSEDED`, `NOTE`. Unknown kinds are ignored.
- Attribute order: `key`, `status`, `by`, `value`, `date`, `reason`,
  `reopen`, `text`. Attributes are lowercase; kinds display uppercase.
- Values are bare when safe (`A-Za-z0-9 ._-:/`) and JSON-quoted otherwise; both
  parse. `status` displays `ACCEPTED|BLOCKED` and parses case-insensitively.
- `date` is `YYYY-MM-DD`. `DECISION`/`DEAD`/`SUPERSEDED` require `key`;
  `NOTE` requires `text`.
- Placement: ledger markers render in the startup decision projection
  (`## FACTS` → `## BLOCKED` → `## DEAD — DO NOT USE`); captured candidates
  quarantine in `pending` until promoted. Capture tolerates the historical
  `LODESTAR NOTE: <text>` line as a `NOTE` marker.

Use narrow stable keys and canonical bare values:

- `lodestar decision set <key> <value> [--status blocked] [--reason <text>]`
- `lodestar decision status <key> accepted|blocked [--reason <text>]`
- `lodestar decision drop <key> [--reason <text>]`
- `lodestar decision show`
- `lodestar decision inject on|off [--reason <text>]`

Each operation appends an event for the canonical project. Current values,
blocked values, and superseded values are derived from history; old values are
not separately edited. A dropped key has no current value. Repeating the current
value or status is idempotent. For `A -> B -> A`, `A` is current and appears
only under facts; `B` remains dead.

## Marker vocabulary

The projection renders the golden-rule marker syntax so what an agent sees is
what it can record:

- `[DECISION key=<key> status=ACCEPTED value=<value> date=<YYYY-MM-DD> reason="..."]`
  under `## FACTS`;
- `[DECISION key=<key> status=BLOCKED ...]` under `## BLOCKED` (paused on a
  named blocker, still current);
- `[SUPERSEDED key=<key> by=<key> value=<old> ...]` and
  `[DEAD key=<key> value=<old> ...]` under `## DEAD — DO NOT USE`.

Every dead item also renders the negation sentence under its marker —
`<old> is DEAD; do not propose, use, or restore it. Use <current>. Reason: ...` —
because the negation is the product: a killed value must be unmissable and must
never silently resurface.

## Kill authority and revival

A direct CLI write is the Director acting; a hook-captured marker is the agent.
Director-issued kills render `reopen=director` and stay closed: only the session
that issued the kill may set the same value again, and a different session is
rejected with `dead_decision_revival` (a replacement value is always allowed).
Agent-issued kills reopen by evidence: any later set revives the value and retires
the dead statement. Old kills recorded before authority existed replay as
agent-issued (open). `--authority director|agent` is optional on `decision set`
and `decision drop`; the default is `director`, and the hook always passes
`agent`.

The Stop hook captures the same bracketed markers from an agent's final message
and appends them to the ledger with the host session identity: a value-bearing
`DECISION` creates or replaces a fact, a bare status marker updates an existing
fact (and quarantines as a pending candidate when the key is unknown), and
`DEAD`/`SUPERSEDED` drop it. Capture is idempotent and never blocks a session.

Startup renders complete deterministic facts and negations. A dead value means do
not propose, use, or restore it; use the current value and its reason instead.
Turning injection off preserves history but omits the projection from startup.

Store product decisions, not brainstorms, temporary progress, secrets, tokens,
personal data, raw logs, TODO lists, or commit identifiers. Use
`lodestar doctor` for event and projection integrity. Never edit event records or
the SQLite database directly.