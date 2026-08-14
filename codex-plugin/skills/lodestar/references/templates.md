# Agent instruction templates

Use these package-owned templates as starting points, not as authority over the
user or a repository's existing instructions.

| Template | Purpose |
| --- | --- |
| `assets/templates/AGENTS.template.md` | General repository instructions |
| `assets/templates/CLAUDE.template.md` | Claude-compatible project guidance |
| `assets/templates/SOUL.template.md` | Named agent persona guidance |
| `assets/templates/_stub-pattern.AGENTS.md` | Minimal repository stub |

Before copying a template:

1. Read the existing destination and the nearest governing instructions.
2. Select the smallest relevant template; examples are not universal policy.
3. Replace every `{{PLACEHOLDER}}` and remove inapplicable sections.
4. Preserve existing work. Do not overwrite a destination without explicit
   authorization; show a diff when modifying an existing file.
5. Keep all operational references on the unified `lodestar` command surface.

Run `lodestar skills verify --target <client>` to prove that these source
templates match the installed package. Run `lodestar skills sync` to reconcile
managed files; Lodestar backs up a differing managed skill before replacement.
