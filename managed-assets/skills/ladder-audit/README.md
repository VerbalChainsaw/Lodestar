# Ladder Audit

A universal coding-agent skill for turning slow, ambiguous end-to-end work into a small inside-out sequence of diagnostic experiments.

## What it does

Ladder Audit preserves the real broad outcome as the final graduation gate, then:

1. freezes already-proven capabilities;
2. starts at the deepest unproven boundary;
3. supplies outer prerequisites through test setup;
4. removes one capability-class scaffold per rung;
5. qualifies independent oracles and reset rules;
6. routes the first failure to one owner;
7. runs a bounded transfer probe;
8. graduates through the unchanged outcome and recovery replay when relevant.

It is deliberately not a recipe generator, exhaustive test matrix, code-quality review, or replacement for final integration proof.

## Skill boundaries

| Need | Skill |
|---|---|
| Localize one suspected defect | `center-audit` |
| Decompose one broad multi-capability outcome | `ladder-audit` |
| Hunt adjacent regressions after a change | `regression-scout` |

## Package contents

Canonical source contains:

- `SKILL.md`: doctrine and compact output contract
- `references/output-template.md`: optional formal downstream artifact
- `references/worked-examples.md`: bounded examples in three domains
- `validate.ps1`: package and coherence checks
- `install.ps1`: validated multi-agent installation and legacy-name cleanup

Runtime agent copies intentionally contain only `SKILL.md`, this README, and the two references. Installation and validation remain canonical-source operations.

## Canonical source

```text
<HOME>\Development\JordanWorkspace\shared\skills\ladder-audit
```

Runtime copies are derived. Edit the canonical source, validate it, then reinstall.

## Runtime destinations

Primary installed roots:

```text
<HOME>\.codex\skills\ladder-audit
C:\Hermes\skills\software-development\ladder-audit
<HOME>\.config\opencode\skills\ladder-audit
<HOME>\.claude\skills\ladder-audit
```

The installer also uses existing Gemini or Cline skill roots when discovered. It does not invent a Kilo skill directory when none is configured.

## Typical invocation

```text
Use Ladder Audit on this outcome. Preserve the unchanged graduation request, freeze proven capabilities, start at the deepest unproven boundary, remove one capability-class scaffold per rung, qualify reset and external oracles, identify evidence-backed pre-fixes, and recommend exactly one first rung.
```

Review mode:

```text
Review this test plan with Ladder Audit. Flag coupled variables, hidden state, weak oracles, low-value rungs, scenario-specific shortcuts, missing transfer probes, and any absent unchanged graduation gate.
```

## Release

Version `1.1.0`, methodology `outcome-anchored-scaffold-fading`.
