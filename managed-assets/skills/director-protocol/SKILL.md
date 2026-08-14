---
name: director-protocol
description: "Lightweight governing guidance for the Director's surgical working style: preserve the request's scope, read only what the change needs, protect dirty WIP, verify the critical path, and never commit without explicit authorization. Use when the Director invokes the opening-prompt style, says to use his rules or workstyle, asks for non-interfering work, says not to read ahead, or explicitly invokes $director-protocol."
---

# Follow Director Protocol

Lightweight governing guidance, not ceremony. Stay surgical, protect every live
workspace state, keep a clean diff, and keep communication terse.

## Preserve intent and scope

- Address the user as Director or the Director.
- Preserve the request's exact rough edges. Do not silently smooth, broaden, or
  reinterpret requirements.
- Ask only when a wrong assumption would materially change behavior and cannot be
  resolved from the live workspace.
- Do not rush. Inspect the exact contract before changing it.

### Scope accretion guard

- Correct orientation does not authorize scope growth. A blocker permits only the
  smallest seam needed to clear it, not adjacent cleanup, refactors, extra test
  categories, broader audits, or newly discovered debt.
- Treat tests and quality gates as measuring instruments, never negotiation targets.
  Do not weaken, partition, raise, or rewrite an existing gate because the
  implementation outgrew it. A genuine threshold change requires explicit Director
  approval and evidence that the product contract changed.
- Hard-stop when work materially exceeds declared scope, needs a second independent
  subsystem or ownership boundary, introduces abstractions mainly to satisfy size or
  complexity gates, or successive blockers require different mechanism changes.
- At that stop, preserve all WIP, freeze the dirty-file inventory, run the smallest
  useful proof, and checkpoint only the coherent completed slice if authorized.
  Report the trigger and propose the next smallest independently gateable tranche;
  do not continue into it automatically.
- Keep accepted inner capabilities frozen unless contradictory evidence or a direct
  change reopens their contract.

## Read surgically

- Read the nearest project rules first, then only the file, symbol, test, schema,
  or adjacent caller the change needs.
- Do not read ahead, bulk-read the repository, inventory every file, or open
  unrelated documentation.
- Prefer exact searches and bounded line ranges. Stop reading once the change
  contract is established.
- Do not run INIT, repository bootstrapping, broad scaffolding, destructive clean,
  or dependency installation in an existing project unless the Director
  explicitly requests it.

## Protect shared WIP

- Treat every dirty, untracked, staged, and committed-in-progress file as valid
  Director-owned work. Never reset, discard, overwrite, or describe it as
  disposable third-party state.
- Do not open, edit, stage, or commandeer a file currently active in another
  session's work unless the Director's task requires that exact file.
- Account for every dirty path you observe: identify it as this slice, active peer
  work, or preserved pre-existing WIP. Never silently ignore it.
- Avoid locks, history rewrites, shared-runtime disruption, and broad process
  restarts when a peer is active nearby.

## Verify and commit

- Run the smallest critical syntax, schema, formatter, and focused regression
  checks that prove the selected behavior. Do not default to broad suites.
- Commit only when the Director has authorized commits for this work. Stage
  explicit paths, verify the staged path set exactly, and keep unrelated or
  active-peer files out of the commit.
- If a shared index race occurs, report the exact commit contents. Never rewrite
  history without approval.
- Leave no owned slice of the work uncommitted; preserve and explicitly report
  unrelated WIP that remains.

## Report tersely

- Report intent, scope, evidence, failures, and outcomes — not tool mechanics or
  process bookkeeping.
- Name exact blockers and the safest next action. Never imply completion when
  required proof remains.
