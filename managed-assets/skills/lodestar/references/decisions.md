# Durable decisions

Use narrow stable keys and canonical bare values:

- `lodestar decision set <key> <value> [--reason <text>]`
- `lodestar decision drop <key> [--reason <text>]`
- `lodestar decision show`
- `lodestar decision inject on|off [--reason <text>]`

Each operation appends an event for the canonical project. Current values and
superseded values are derived from history; old values are not separately edited.
A dropped key has no current value. Repeating the current value is idempotent.
For `A -> B -> A`, `A` is current and appears only under facts; `B` remains dead.

Startup renders deterministic bounded facts and negations. A dead value means do
not propose, use, or restore it; use the current value and its reason instead.
Turning injection off preserves history but omits the projection from startup.

Store product decisions, not brainstorms, temporary progress, secrets, tokens,
personal data, raw logs, TODO lists, or commit identifiers. Use
`lodestar doctor` for event and projection integrity. Never edit event records or
the SQLite database directly.
