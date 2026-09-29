# A Codex-first harness with recoverable work

This integration recipe describes a tested division of responsibility. It does
not add an orchestrator, hook owner, server or scheduler to Lodestar.

## Ownership

| State or operation | Owner | Durable evidence |
| --- | --- | --- |
| Live agent execution, cancellation and worker status | The selected native Codex runtime; explicitly selected OMX modes use their documented runtime | Actual session and worker IDs, terminal events and tool outcomes |
| Project continuity, decisions and handoff | Lodestar, through its contract-5 executable/API | Revisions, write bases, request IDs and mutation receipts |
| Source and release history | The component's canonical Git repository | Exact commits and remote branch readback |
| Installed skill/runtime copies | The existing component installer or guarded publisher | Ownership manifests, preimages, backups and post-install hashes |
| Research | Source-backed Markdown records | Source links, scope, retrieval date, corrections and supersession |
| File replacement and captured output | Utility-belt's guarded owners | Expected bytes, complete output, hashes and receipts |
| Planning and diagnosis | Codeplan and Center Audit | Selected mechanism, observed invariant, causal evidence and falsifier |

One task has one current checklist. The native runtime owns worker state;
Lodestar references that state instead of maintaining a competing worker queue.
Memory is evidence to reconcile with source and the current brief, never an
authority to overwrite new instructions or dirty work.

## Start, implement and recover

1. Run `lodestar start --cwd <project> --harness codex --target codex`, read native
   project instructions, inspect current source and identify overlapping work.
2. Persist a compact checklist before the first implementation change. Include
   outcome, owner, acceptance evidence, protected files, current step and next
   action. Use the same handoff after interruption.
3. Use Codeplan for consequential alternatives or state/process boundaries.
   Keep a conservative candidate. Use Center Audit when a concrete defect's
   cause or safe repair boundary is uncertain. A proven literal correction needs
   a routing note and focused check, not a new orchestration workflow.
4. Establish the baseline. Give each child an exact objective, owned files,
   read scope, exclusions, tests and return conditions. Use fresh contexts where
   independence matters, and an explicitly supported affordable model. A role
   catalogue is not evidence of the model actually selected.
5. Serialize overlapping edits. Preserve unrelated staged, dirty and untracked
   work. Never treat a completed agent turn as proof that its deliverable is
   complete: a worker may correctly return partial or blocked work.
6. Validate changed behavior and inspect the diff. Use a separate reviewer for
   important repairs. Broaden tests for concrete dependencies and platform
   boundaries; do not lower thresholds or skip failed assertions.
7. Save evidence through the existing handoff with a fresh `write_basis` and
   unique request ID. Verify the returned bytes/hash before relying on a saved
   output file. If the mutation response is lost, replay its exact body and ID.

On recovery, query actual worker state. Validate complete artifacts and retain
partial ones before repair. If an external operation timed out, inspect its
destination and receipt before retrying. A missing response does not mean the
operation failed. Keep historical failures alongside successful retries.

## Configuration and diagnostics

Help and status commands should be observational. Test them against a repairable
configuration and require unchanged bytes and modification time, no runtime
artifacts, correct argument/environment forwarding and correct exit propagation.
Normal launch repair is a separate contract.

Qualify configuration using its parser, protected field comparisons, maintained
repair logic on disposable copies, and actual supported runtime checks. Do not
reconstruct an unavailable historical preimage by guesswork. A recovered older
snapshot can support invariant comparisons without proving the exact later
incident delta.

Hook diagnostics must distinguish configuration, invocation, routing and effect.
Two reconciliation log entries may describe one canonical session. Child task
creation is not proof of a child hook invocation. Optional tracing must be off by
default, bounded, preserve hook protocol output, and exclude prompts, tool
arguments, credentials and other payload contents. Diagnostic correlation never
grants mutation authority.

## Intent supervision and stop behavior

A useful supervisor is a bounded independent review lane with an explicit brief,
review interval or milestone, and a required coordinator acknowledgement of
actionable corrections. It checks intent, scope, ownership, cost, open defects
and unsupported completion claims. It does not duplicate the task database.

Use the host's supported scheduler when off-turn wakeups are needed. Record the
actual target and lifecycle. Verify a real scheduled delivery before claiming
persistence. Explicit stop/cancellation must survive a later wake: the monitor
may observe the stop and record a no-op, but must not restart task work. Pause a
task-specific heartbeat when the task ends. Instructions alone do not keep a
stopped process alive.

## Research and optional tools

Capture source notes, decisions, correction links and short synthesis in Markdown.
Use Obsidian as an optional editor if it improves the user's workflow. Admit a
semantic index, code navigation service, provider bridge or connector only after
a representative task demonstrates a useful improvement and its ownership,
privacy, failure and uninstall boundaries are explicit. Do not create another
memory authority simply because a tool is available.

## Verification and release

The acceptance patterns are: a simple repair recovered by a fresh task; an
interrupted coordinator with complete/partial workers and an uncertain external
effect; and a rendered regression rejected despite a passing DOM check, then
recovered from durable evidence. These are harness acceptance tests, not proof
that every product or remote service has been qualified.

Publish only exact task-owned paths. Preserve dirty primary checkouts, test the
candidate, commit, push, and read the remote branch SHA. Installation is a separate
step: retain preimages, replace only owned artifacts, compare the complete
installed inventory, then test the installed command. A pushed commit does not
prove activation. Local patches must remain linked to source commits so an
upgrade can detect replacement and rerun the focused checks.

See [validation and incident history](codex-harness-validation.md), the
[Lodestar schema](../schema.md), [installation](../installation.md), and
[limitations](../limitations.md). Lodestar remains a one-shot continuity owner;
this recipe does not authorize additional services, direct database edits or
changes to permission, sandbox or trust policy.
