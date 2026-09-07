# Durable decisions

Use narrow, stable keys whose punctuation is meaningful. Read all current streams with
`lodestar decision show` or one stream with `lodestar decision show <key>`. Write with
`decision set|status|drop|inject --file <request.json>` using the current read basis and
the exact structured input declared by the installed package.

Every accepted change records its reason and semantics. The current answer is derived
from accepted event revisions, never wall-clock ordering. Reversals preserve prior
events; repeating identical meaning is a no-op, while a new material reason remains
history. Competing stream heads stay explicit until a checked resolution names the
heads and reason.

Use `accepted` for a standing choice, `blocked` for a standing choice paused on a
specific blocker, and `dead` or `superseded` only when the record's meaning supports
that transition. Do not infer user attribution from a shell invocation, a boolean
authority flag, or arbitrary prose. An agent may record an agent inference with honest
semantics; authenticated user direction requires actual host evidence.

Store consequential product or project choices. Leave brainstorms, secrets, raw logs,
and temporary narration out of the decision stream. Never edit event rows directly.
