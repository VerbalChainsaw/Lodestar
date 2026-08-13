---
name: handoff
description: Save a validated project handoff. Use only when the user's entire trimmed prompt is exactly `handoff now` or the exact `$lodestar:handoff handoff now` equivalent.
---

# Lodestar Handoff

For the exact command `handoff now`, call the bundled `handoff_now` MCP tool exactly once. Do not use a shell command or copy a packet identifier manually.

Author the complete semantic `packet` requested by the host context. It must contain `goal`, positive `rules`, typed `entries`, `work`, `nextMove`, and `evidence`. The host binds the tool call to the current session, turn, tool call, and cwd; the plugin validates and redacts the packet before Lodestar saves it.

The next eligible Codex session in the same project receives and atomically claims the handoff during `lodestar start`. The source session cannot claim it, the claimant can retry safely, and later sessions cannot steal it.
