# Agent instruction templates

Use these package-owned templates as starting points, not as authority over the
user or a repository's existing instructions.

| Template | Purpose |
| --- | --- |
| `assets/templates/AGENTS.template.md` | Version-controlled project operating rules |
| `assets/templates/CLAUDE.template.md` | Claude-compatible project guidance |
| `assets/templates/SOUL.template.md` | Named agent persona guidance |
| `assets/templates/_stub-pattern.AGENTS.md` | Canonical minimal Lodestar bootstrap |

## Choose one owner for each rule

Lodestar does not inspect or synchronize repository instruction files. The full
template and the minimal stub are alternatives, not layers to install together:

- Keep a project-specific rule in the repository when it must be versioned with
  the code or available before and independently of Lodestar startup. Store only
  a narrow durable decision or source pointer in Lodestar when cross-session
  projection is useful.
- Use the minimal stub only after `lodestar start` is proven to return every
  required project rule completely under the normal startup budget. A record that
  can be shed, summarized, or retrieved only by follow-up is not bootstrap
  authority for removing the native rule.
- Never maintain the same detailed doctrine in both places. Move a rule only with
  an explicit authority decision, verify the destination, then remove the former
  copy in the same change.

The minimal stub is the canonical package bootstrap text. It deliberately names
command families rather than individual subcommands so an evolving capability
cannot leave a retired command in a generated agent file.

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
