# Lodestar roadmap: session evidence ingestion

**ID:** LD-ROADMAP-CHAT-INGEST-01
**Status:** A bounded one-shot, metadata-only review tool is implemented under tools/chat-evidence. No running watcher, integration with live transcripts, unattended record writes, or new background component is delivered.
**Owner:** Lodestar project owner.

## Delivered step

The earlier prototype's append-only cursor, explicit per-file scope, classification, replay handling, and project-local deduplication are retained. The supported command makes one explicit pass and exits; it accepts only exact opt-in sources and writes a private cursor and proposal metadata, not snippets or Lodestar state. Missing or uncertain evidence stays a proposal. Codex and Claude Code adapters are exercised with synthetic records. DeepSeek and other harnesses are not yet implemented.

The installed Lodestar command contract, package hooks, setup, launchers and SQLite ownership are unchanged. The original watcher prototype is not runnable in this integration. Its periodic-loop logic was set aside because it is not needed to preserve the extraction and review work and would require a separate operational boundary.

## Further decisions

- Independently verify repository claims with Git. Conversational assertions, candidate categories and source offsets are not proof or authority.
- If automatic collection is reconsidered, resolve source admission, data retention, harness ownership, stop controls, and consent before adding operational integration. Do not extend the one-shot Lodestar runtime or discover wider scope from an opted-in file.
- Separately authorize any guarded idempotent typed-record write and define stale-basis, approval, rollback and replay checks. This tool never promotes a proposal.
- Project-memory retrieval from Lodestar into Next Prompt is independent of this source-review tool.
