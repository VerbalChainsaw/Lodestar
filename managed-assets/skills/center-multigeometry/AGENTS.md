# Agent Rules for `center-multigeometry`

This bundle is the canonical git-tracked source for the `center-multigeometry` skill in this standalone repo.

## Source of truth

When editing this bundle, treat all three as authoritative together:
- `../../docs/spec/10-skill-draft.md`
- `../../docs/spec/01-product-requirements.md`
- the live built CLI help / behavior from `../../dist/cli/main.js`

The requirements draft gives the doctrine.
The built artifact gives the commands that actually exist.
If they disagree, document the live CLI honestly and keep the doctrine.

## Maintenance constraints

- Keep `SKILL.md` self-contained. Do not add load-bearing `references/` links unless you also redesign install mode; Hermes and Mavis targets receive `SKILL.md` only.
- Do not teach commands that are absent from `node dist/cli/main.js --help`.
- Do not turn hypotheses into confirmed defects in the skill body.
- Do not teach repair steps; escalation goes to `center-audit`.
- Do not leak secrets in examples or copied report excerpts.

## Required verification after every edit

Run, in order:

```bash
python validate_skill.py
python validate_skill.py --selftest
python install_skill.py --verify-only
```

If the skill body changed, also run:

```bash
python install_skill.py
```

## Commit discipline

- Commit only the skill bundle files for a skill-only packet.
- If the app behavior changed and the skill had to change because of it, mention the coupling explicitly in the commit message.
- Do not re-introduce machine-local absolute paths into the public skill bundle.
