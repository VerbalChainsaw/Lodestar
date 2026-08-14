# Changelog

## 1.1.0 - 2026-07-02

- split `validate_skill.py` into portable, local, and full `--selftest` modes so extracted bundles no longer fail just because machine-local paths are absent
- hardened `validate_skill.py` to compile both Python scripts and validate the real scan/diff JSON structure, coverage keys, geometry runs, hypotheses, investigation packets, and diff contract
- taught the selftest to assert the live geometry set (`radial`, `cycle`, `boundary`, `anomaly`, `convergent`, `path`) from real `engine_runs`
- added installer guardrails in `install_skill.py`: fixed allowed roots, basename checks, and optional `--backup-dir` snapshots before replacement
- kept the original end-to-end built-CLI proof path intact while making the validator honest about what is portable versus machine-local

## 1.0.0 - 2026-07-02

- initial `center-multigeometry` skill landing from the CENTER-MULTIGEOMETRY requirements package
- kept the SKILL body self-contained so Hermes and Mavis SKILL-only installs remain usable
- added `validate_skill.py` end-to-end selftest against the real built `center-geo` CLI
- added `install_skill.py` fan-out to Hermes, Mavis, OpenCode, Claude Code, and Codex roots
- grounded the skill in the live `scan` and `diff` commands instead of older aspirational CLI sketches
