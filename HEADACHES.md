# HEADACHES.md — chronic frictions and root-cause fixes

Session log per Director rule 9. Each entry names the repeated grief and the
root-cause fix option. Nothing here is acted on without Director approval.

## 1. Sandbox EPERM blocks every test run (recurring, highest friction)

- **Grief:** `node --test` (and any Node child process with piped stdio) fails with
  `spawn EPERM` under the confined DSH sandbox. Every single verification cycle
  requires a `danger-full-access` escalation and approval. Hit 4+ times this session.
- **Root-cause options:**
  - (a) Pre-approve the exact test command (`node --test` / `npm test` in the Lodestar
    workspace) so escalation is a one-time grant, not per-run.
  - (b) Add a DSH sandbox affordance: allow child-process spawn with piped stdio inside
    the session workspace (test runners are the legitimate use).
  - (c) An in-sandbox test path that avoids child processes (not available in node:test
    file mode; would need a custom in-process runner — not worth it).
- **Recommendation:** (a) or (b). This friction recurs on every verify loop.

## 2. PowerShell 7.3+ native argument passing surprises (recurring class)

- **Grief:** a PS variable holding multiple flags (`$s="--session x --agent y"`) passed to
  a native command arrives as ONE argument (PSNativeCommandArgumentPassing Standard mode),
  so `lodestar decision set ... $s` failed with `unknown_option` and the whole string
  as the option name.
- **Root-cause fix:** never splat a space-containing string variable into a native
  command; pass individual arguments or use an array with the splat operator (`@args`).
  Add a note to the Lodestar dev docs (or a shell helper) so scripters don't hit it.

## 3. Write-tool "file changed since read" policy (minor)

- **Grief:** mid-edit re-reads are required after long pauses; slows chained edits.
- **Root-cause:** by-design fs-observation; acceptable. No action.

## Fact, not a headache: live DB is ACL read-only to sandboxed processes

`Gigaflex\CodexSandboxUsers` has RX only on `%LOCALAPPDATA%\Lodestar\lodestar.db`
(SQLITE_READONLY on writes). Deliberate machine boundary matching the 2026-08-19
live-readonly cutover. Do not weaken; sandboxed sessions record decisions via Q&A.md
and let a non-sandboxed session transcribe to the ledger.
## 4. Root-cause win found this session: in-process test execution

- Running a test file directly (`node test/<file>.test.mjs`) executes its tests
  in-process with NO child spawn, so the confined sandbox allows it.
- 15 of 22 test files pass this way (all core logic: decision, records, queries,
  json, continuity, pending, doctor, migration, agents, skills, ...).
- The 5 spawn-dependent files (plugin, e2e, concurrency, package, work-identity)
  and 4 spawn/timing tests inside otherwise-fine files (cli, database, release,
  windows-install) still require an escalated `node --test` run.
- **Recommended process change:** make the escalated full-suite run the only
  approval-gated step; use in-process per-file runs for day-to-day loops.

## Class split (the missing link, recorded 2026-08-20)

Reflection surfaced TWO classes; fixes map by class:

- CLASS A — session/environment friction (items 1-3 above): resolved by environment
  and policy changes, not by repo work.
- CLASS B — structural accretion: machinery that outlives its justification
  (wrappers, verdict-bearing helpers, governance layers, review grammars,
  command-surface bloat). This is the chronic workshop headache and the class the
  "repair the lowest shared owner" doctrine treats.

Class B cures in this session:
- Lodestar: capture functions merged into one mechanism; marker grammar unified
  into one module; SUPERSEDED successor edge repaired (185/185 green).
- golden-helpers (Codex, independently verified): deleted 826 lines
  (planreview.py + verdict-bearing surface-owner.py/audit-limit.py), renamed the
  two evidence commands (surface-volatility.py, trace-limit.py), zero new
  machinery, review capability returned to its existing owner.

The golden-helpers correction does NOT touch class A; it is a class-B cure.
