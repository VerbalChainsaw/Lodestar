# Scoped knowledge

Use `lodestar get <id-or-alias>` for an exact subject, `lodestar find <query>` when the
identifier is unknown, and `lodestar links <id-or-alias>` for one explicit relationship
hop. Add a positive page limit only when the caller actually wants a page. Missing
knowledge means Lodestar lacks the record; inspect the source normally.

Reads return current records with provenance, semantics, source status, and a usable
write basis. `get --history` retrieves retained revisions and associations. `get --raw`
preserves exact evidence for a malformed legacy numeric row that cannot safely enter
JavaScript's normalized number domain.

During authorized work, update an existing subject once when its meaning or evidence
changes. Send a short contract-5 request containing `request_id`, `write_basis`, and
`input`; the core supplies incidental hashes and revision mechanics. Retire a subject
through `delete` so current orientation omits it while exact history remains available.

Source freshness is evidence, not age-based authority. Inspect and hash the same stable
bytes, preserve prior observations, and mark an unstable or changed source for
reinspection rather than claiming current verification.

A current `content_owner` backed by a local file or package manifest is re-read before
write admission and must match its exact locator, byte count, and SHA-256. A
`source_root` locator includes `source_id`; retain the returned
`config:lodestar:sources` precondition so a root change cannot reuse the old basis.
