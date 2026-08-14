# CENTER-AUDIT: Machine-Readable Output

Use only when the caller requests structured output or a downstream agent/orchestrator will consume the audit.

Emit one JSON object conforming to:

`assets/center-audit-output.schema.json`

## Rules

- Emit JSON only, with no Markdown fence, when strict machine output is requested.
- Set `schema_version` to `2.0.0`.
- Use stable evidence IDs and reference them from defects, trajectory links, contradictions, disproofs, and verification checks.
- Keep hypotheses outside `confirmed_defects`.
- Use empty arrays rather than omitting required collection fields.
- Use `null` only where the schema permits it.
- Do not invent exact revisions, commands, trace IDs, or line numbers.
- Redact secrets and sensitive payloads while preserving enough identity to reproduce safely.
- `result` is one of `DEFECT_CONFIRMED`, `NO_DEFECT_CONFIRMED`, or `INCONCLUSIVE`.
- Severity appears only on confirmed defects.
- An unproven trajectory link must set `proven` to `false`; it cannot support `CERTAIN` likelihood.

## Compact consumer contract

Downstream repair agents should primarily consume:

- `case_file.center_anchor`
- `case_file.expected_invariant`
- `fusion.root_cause`
- `confirmed_defects`
- `blast_radius`
- `repair_contract`
- `verification`
- `non_scope`

They should not reinterpret non-center observations as repair requirements.
