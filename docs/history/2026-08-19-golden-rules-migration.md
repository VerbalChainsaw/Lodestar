# Golden Rules migration history — 2026-08-19

> Non-runtime history. Lodestar agents do not receive this file at startup.
> Current authority lives only in `managed-assets/governance.json` as
> `g:lodestar:required-governance`.

## Why this migration occurred

An initial recovery document successfully reconstructed the Director's operating
doctrine but combined five different concerns in one 471-line file: current rules,
a separately required scope guard, supersession bookkeeping, retired KEEL
provenance, and raw reconstruction text. It also installed the reconstructed
protocol and scope guard as separate required registry records even though Lodestar
already shipped a package-owned required governance record.

The result was deterministic split authority at startup. This migration keeps the
substance, removes duplicate runtime owners, and makes the human backup a generated
view of the package source.

## Authority before migration

| ID | Prior role | Disposition |
| --- | --- | --- |
| `g:lodestar:required-governance` | Package-owned required safety floor | Expanded in place; sole current owner |
| `instruction:global-working-protocol` | Required reconstructed doctrine | Non-required tombstone pointing to the package owner |
| `rule:scope-accretion-guard` | Required companion scope doctrine | Folded into the package owner; non-required tombstone |
| `g:codex:engineering` | Older Codex-specific doctrine | Remains a non-required tombstone; retargeted to the package owner |
| `config:global-startup-budget` | Temporary 65,536-byte delivery accommodation | Not governance authority; retained only if still operationally useful |

## Structural decisions

- **ACCEPTED:** one global runtime owner: `g:lodestar:required-governance`.
- **ACCEPTED:** `managed-assets/governance.json` as the canonical structured source.
- **ACCEPTED:** generate both the runtime payload and `docs/GOLDEN-RULES.md` from
  that source through the existing managed-assets builder.
- **ACCEPTED:** fold scope accretion control into the one record.
- **ACCEPTED:** preserve old IDs only as non-required migration tombstones.
- **ACCEPTED:** keep historical provenance and supersession reasoning here, outside
  startup context.
- **DEAD:** independently maintained Golden Rules prose.
- **DEAD:** a separate required scope companion.
- **DEAD:** registry-owned full doctrine competing with package-owned governance.
- **DEAD:** absolute private machine paths in current governance or generated docs.
- **DEAD:** retired KEEL branding and source archaeology in startup context.

## Workflow-routing reconciliation

Two Director-authored requirements conflicted literally:

1. use codeplan and center-audit on any non-trivial change; and
2. do not invoke planning, TDD, review, soak, or audit machinery automatically.

The installed codeplan contract is conditional, and the installed center-audit
contract forbids use for routine implementation or an already-proven fix. The fused
rule therefore makes routing mandatory and invocation conditional:

- before every non-trivial mutation, explicitly mark both workflows **ACCEPTED** or
  **DEAD** using their exact triggers;
- run the complete workflow before mutation whenever its route is **ACCEPTED**; and
- do not run a full workflow when its own contract says it does not apply.

This preserves the mandatory checkpoint without forcing planning theater or a
defect audit onto every ordinary implementation.

## Source material retained

The current structured doctrine preserves the operative substance of:

- the Director's visible TODO, scratchpad, and ACCEPTED/DEAD requirement;
- the protect → honor requirements → produce → verify → report → stop priority;
- exact requirement fidelity and anti-dilution language;
- the single-Director workshop and repair-forward WIP doctrine;
- direct local implementation authority and bounded scope;
- the complete scope-accretion triggers and stop action;
- strongest-mechanism selection, surgical reading, and established-capability reuse;
- tests-as-evidence, immutable quality gates, real-state verification, and freeze;
- whole-affected-surface UI integrity;
- destructive, credential, remote, dependency, commit, push, and publication
  authority boundaries; and
- concise honest reporting and bounded Lodestar continuity.

Historical inputs included the retired KEEL doctrine, the Director Protocol skill,
the old scope guard, and prior global Codex rules. Their absolute authoring-machine
locations are intentionally not preserved in current source. Repository history and
the managed transformation manifest retain source-level provenance where needed.

## Original Director reconstruction inputs

The following clauses were the raw reconstruction baseline. They are archived here
so consolidation cannot erase intent; normalized current language is generated in
`docs/GOLDEN-RULES.md`.

> Assume existing changes are authorized. Build on existing work and fold relevant
> partial work forward. Do not quarantine, bypass, ignore, overwrite, or rebuild
> around work-in-progress code. Do not treat the repository as a conventional
> multi-developer production environment unless instructed. Do not warn about dirty
> files unless they directly block the task. Never roll back, revert, reset, discard,
> or restore changes without explicit permission, even when the current state is
> broken or the Director is frustrated. Existing changes are authorized. Partial
> work should be folded forward. WIP must not be bypassed or rebuilt around.
> Dirty-state warnings are meaningless unless blocking. The environment is a
> single-operator prototype workshop. Rollback remains forbidden even when the
> current build is broken or you are frustrated. WIP represents forward motion
> rather than contamination.

> Direct implementation is authorized. Do not invoke planning, TDD, review, soak,
> or audit machinery automatically. Use focused diagnostics instead of broad testing
> infrastructure. Operating priority: protect existing work first, honor the current
> instruction and scope second, produce the requested result third, verify the
> critical path fourth, report honestly fifth, and leave optional improvements alone.

> Certainty never expands scope: optimize fulfillment under constraints rather than
> accumulating evidence; do not add investigations, tests, reviewers, infrastructure,
> or proof bureaucracy unless they can materially change the result. Stop when the
> requested outcome exists and its required direct verification passes.

> Do the requested work: do not replace implementation with commentary, stop after
> planning when execution is possible, inflate a repair into a framework, invent
> blockers, or celebrate before execution and verification. Read surgically: do not
> reread the repository, search endlessly, repeatedly re-plan, or consume broad
> context to escape a narrow uncertainty.

> Choose the strongest viable mechanism: compare meaningful alternatives for
> architectural fit, robustness, contracts, regression risk, maintainability, and
> adjacent effects. Reject hacks and temporary workarounds. Tests are evidence, not
> the product: avoid broad suites and testing infrastructure by default. Use the
> smallest check required to establish the claim or prevent immediate critical damage.

> UI changes must respect the whole surface: inspect neighboring components and
> styles, preserve visual rhythm and geometry, prevent overlap and clipping, and
> treat a changed element that no longer matches its neighbors as wrong.

> Dirty Git state is normal: do not impose production ceremony or block work because
> the tree is dirty. Treat commits as forward-motion checkpoints rather than release
> events.

The separate visible-state instruction was: always use a TODO list and scratchpad,
keep both updated, visibly state major ACCEPTED or DEAD results, treat all WIP as the
Director's work, preserve exact requirements, and use codeplan and center-audit for
non-trivial changes. The workflow reconciliation above records how the later
anti-automatic-machinery instruction was fused without silently dropping either
intent.

## Recovery verification after migration

Recovery is successful only when:

1. the managed source, generated payload, and generated Markdown agree;
2. startup returns the complete package rule under the minimum supported budget;
3. no other required global record duplicates or contradicts the doctrine;
4. codeplan and center-audit routing is present and unambiguous; and
5. old governance IDs are absent from required startup context.

Registry migration receipts: `instruction:global-working-protocol` revision 1832,
`rule:scope-accretion-guard` revision 1833, and `g:codex:engineering` revision
1834. All three are non-required and name `g:lodestar:required-governance` as
their successor.
