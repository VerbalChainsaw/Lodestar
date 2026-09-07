# Continuity

Continuity preserves an explicit checkpoint; it never creates, resumes, or rotates a
host session. The current commands are:

- `lodestar handoff status|history`
- `lodestar handoff arm|checkpoint|now|claim|disarm --file <request.json>`

Writes use the same contract-5 request, basis, receipt, and revision rules as every
other mutation. The structured input is declared by the installed package. Preserve
the task goal, accepted constraints, completed work, current state, exact next move,
and evidence needed to continue. Do not infer a decision or success from arbitrary
conversation prose.

Claims require actual host actor/session identity. A native tool that cannot obtain
authenticated host identity must leave it absent and return the resulting identity
error; it must never fabricate a user, session, or claimant.

History and closed packets remain retrievable. A pending transfer is claimed at most
once through an explicit checked mutation. Failed or interrupted attempts remain
retryable, and a lost successful response replays from its request receipt. Lodestar
does not capture message tails or maintain a private session authorization cache.
