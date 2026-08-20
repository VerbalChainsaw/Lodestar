# Agent instruction templates

Use these package-owned templates as source material, not as authority over the user or
a repository's existing instructions.

| Template | Purpose |
| --- | --- |
| `assets/templates/AGENTS.template.md` | Version-controlled project operating rules |
| `assets/templates/CLAUDE.template.md` | Project guidance for environments that use that filename |
| `assets/templates/SOUL.template.md` | Named-agent identity guidance |
| `assets/templates/_stub-pattern.AGENTS.md` | Canonical minimal Lodestar bootstrap source |

## Lodestar is read-only at this boundary

```text
lodestar agents status --cwd .
lodestar agents verify --cwd .
lodestar agents template --mode stub|full --cwd .
```

These commands inspect or print. They never create, replace, upgrade, back up, or remove
an AGENTS.md file. Lodestar also never writes a global agent file through the skills
command. Copying or merging a template is a deliberate user-owned operation performed
outside Lodestar.

## Choose one owner for each rule

The full project template and minimal bootstrap are alternatives, not layers to install
together. Keep detailed project-specific rules in the repository when they must be
versioned with the code or available independently of Lodestar. Use the minimal stub
only when complete required project governance comes from startup. Never maintain the
same detailed doctrine in both places.

Before using a template:

1. Read the existing destination and the nearest governing instructions.
2. Select the smallest relevant template; examples are not universal policy.
3. Replace every placeholder and remove inapplicable sections.
4. Preserve existing work and review the exact diff.
5. Place the result only through the tool or workflow that natively owns that file.

Run `lodestar skills verify --target <client>` to compare existing skill copies with
package source. Run `lodestar agents verify --cwd .` to compare an existing repository
bootstrap with canonical source. Both operations are read-only.
