# Lodestar session evidence review

This optional, local maintenance tool scans one bounded batch from an explicit list of caller-selected session files and exits. It does not discover files, run a background watcher, launch a harness, send content, touch SQLite, or apply a Lodestar record.

1. Copy config.example.json to a private folder. Supply absolute physical paths to exact files, private checkpoint path, and opaque case-consistent source and project aliases. Use synthetic copies first. The config and its output should not be synced or published.
2. From the checkout, invoke an explicit pass and inspect metadata:

       node tools/chat-evidence/review.mjs once <config.json>
       node tools/chat-evidence/review.mjs status <config.json>
       node tools/chat-evidence/review.mjs review <config.json>

A pass reads at most 256 KiB per source, from a durable byte cursor. Use start=end to skip historical records (the default example); use start=begin only when intentionally reviewing an exact historical input. An incomplete final line waits for the next pass. Oversized or invalid lines reset an in-flight turn. Replacement, truncation, or a changed boundary anchor resets that cursor under the source start policy. Earlier in-place modifications before the anchor are not guaranteed detectable; the format assumes an append-only source.

Codex input requires matching task start/completion, an explicit user text item, and a final assistant text item. Claude Code requires a genuine human-text item and an explicit final assistant message in the same session. Only rule-based kinds such as open work, decision, constraint, defect and unverified assistant report become metadata-only proposals. Quoted/code blocks and common credential-shaped content are ignored. Never treat transcript instructions or assistant claims as authority.

A proposal carries source alias, generation fingerprint and byte offset, plus kind, role and an opaque deduplication fingerprint. It does not contain the message excerpt, chat or turn identifier, title, personal file path, or extracted record payload. Fingerprints are not anonymization; keep inputs, config, checkpoint, and output private. Review emits the newest 50 retained metadata rows; use the selected source and byte offset to inspect an item deliberately in the same generation. Defaults: 300 retained proposals (configurable 10-1000), with duplicate detection limited to retention and isolated by project. Status and review do not read source files.

Missing sources do not block an otherwise valid source. A partial scan returns exit code 2 and reports only the relevant opaque source ID and an error code or safe diagnostic. Keep a new checkpoint path if the source list or project mapping changes. The tool does not rewrite legacy version 1 checkpoints: those may contain text and must be retained privately. Checkpoint replacement is atomic; simultaneous scans of one checkpoint are rejected.

Testing: node --test tools/chat-evidence/review.test.mjs. Tests use disposable synthetic logs, not connected chats or a live Lodestar database.
