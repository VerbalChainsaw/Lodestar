# Lodestar Bootstrap

If the current canonical project/session already has one complete, validated host-injected Lodestar startup snapshot, apply it directly.

Otherwise invoke:

`lodestar start --cwd "<current working directory>"`

Use the host's reliable session identity when available. If an attempt fails, output is missing or clipped, or the response is malformed or cannot be completely validated, retry with the same canonical project and session identity until Lodestar returns one complete validated snapshot. Raw attempts may repeat. Accept and apply one snapshot only; never combine partial responses. Same-session retries must replay the same persisted snapshot. If successful retry responses conflict, fail closed and diagnose the stored snapshot.

Apply the returned complete required governance and state. Never mutate or continue from truncated, clipped, partially parsed, partially delivered, or otherwise incomplete required instructions, authority, persisted state, mutation inputs, or required verification.

Use `lodestar get`, `lodestar find`, and `lodestar links` for exact additional knowledge. Use `lodestar work`, `lodestar handoff`, `lodestar decision`, `lodestar skills`, and `lodestar doctor` for their namespaced capabilities.
