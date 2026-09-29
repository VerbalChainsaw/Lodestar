# Harness validation and incident history

## Evidence standard

Keep source revision, operating system, command, exit, expected/actual result,
output integrity and scope with each claim. A synthetic payload, unit test,
native runtime event and rendered inspection are different evidence types.
Prefer the smallest test that establishes the claim, then cover affected
platform and process boundaries. No test suite proves absence of all possible
defects.

## Verified workflow scenarios

| Scenario | Required and observed evidence |
| --- | --- |
| Simple task | Alias and native instructions; checklist before a one-literal repair; failing baseline and focused pass; unrelated tracked dirty bytes preserved; independent fresh task retrieves the handoff and reruns the check |
| Interrupted coordination | Two actual native worker identities, disjoint ownership and complete/partial returns; injected command failure; actual coordinator interruption before integration; fresh recovery queries real worker states |
| Uncertain HTTP effect | Separate disposable loopback server commits one effect before client timeout; fresh recovery compares destination to the request before retrying; no second POST; matching replay is byte-stable and changed-payload replay is rejected |
| Rendered regression | Narrow/wide baseline, deliberately clipped view with DOM presence PASS, repaired view; exact source and image hashes/dimensions; fresh task directly inspects accepted and rejected images |
| Scheduled stop | A real native heartbeat arrives after explicit stop, reads the stop marker and produces only a no-op receipt; source and evidence remain unchanged; heartbeat is paused |
| Missing saved registration | A native project inventory omits the disposable checkout while its Git files and dirty draft bytes remain intact; this distinguishes registration absence from disk loss |

These trials use disposable fixtures. They do not certify a production provider,
unrelated product, physical power-loss durability or arbitrary concurrent writes.

## Repairs and retained history

| Incident | Owner repair and proof |
| --- | --- |
| Safe edit overwrote a competing preimage or rollback edit | Utility-belt now checks current target/manifest bytes before replacement and restores only bytes still owned by the operation. Eight focused and three independent conflict cases, including Linux verification, passed. The final check-to-replace interval is still not a universal filesystem CAS. |
| Status initialized missing configuration | OMX status reports missing configuration without creating it. Explicit init remains the creation owner. Missing/existing/malformed cases and installed runtime checks passed. |
| Exact exec help performed compatibility repair | OMX exact help now forwards before launch/config side effects. Repairable-config byte/mtime preservation, no runtime state, both help flags and child exit propagation are tested. Normal exec retains its repair behavior. |
| Help incident had no contemporaneous config preimage | The write is retained as a real incident. An older preserved snapshot and maintained repair routine support current configuration qualification; they do not recreate the exact incident preimage. No guessed restoration is made. |
| Incomplete or misleading visual capture | Incorrect extension, narrow framing and cached-source captures were retained and excluded. Accepted JPEG magic, dimensions, hashes and connected views were verified. |
| Worker/test environment failures | Permission and temporary-directory failures, missing commands, rejected cleanup and retries remain in the task error history. Original failures are not erased by later successful checks. |
| Actor label duplication | A fully-qualified label was passed to an API expecting a short label. The final checkpoint uses the original default actor and real session; historical attribution is retained rather than rewritten. |

## Reproducible validation surfaces

- Lodestar: `npm test` and managed asset checks in its canonical repository.
- OMX: build first, then the compiled exec, hook-launcher, session and focused
  trace tests for the changed owners. Run the same compiled contracts on Windows
  and Linux when process launching or paths are involved.
- Utility-belt: its committed guarded-edit and capture regression tests, plus
  the installed mirror's owned self-checks.
- Documentation: parse structured evidence, verify repository-relative links,
  check that examples contain no machine-specific home paths or credentials,
  and keep incident history separate from current open defects.

Release records must identify the exact source commits and remote SHAs. Runtime
activation records must separately identify replaced artifacts, their preimages,
backup integrity, unchanged package files, installed test results and the
configuration snapshot used for verification. Private host logs/configuration
remain local evidence and are not copied into public documentation.

## Native child lifecycle release qualification

OMX source `7c7517d0c973875adeb7a0211986ac069df010ee` is the final qualified harness repair.
Native child event payloads use the parent session context and child agent ID;
their transcript metadata uses the child in `id` and may name the parent in
`session_id`. Both mismatches were caught by actual host trials, preserved in
the incident history and covered by regression tests. Foreign or missing native
child identities, mismatched parents and conflicting roles are rejected.

Fresh plain Codex and explicit OMX sessions verify root and plugin invocation,
routing and effects separately. Plain Codex plugin hooks correctly no-op. In
explicit OMX, both observers can record the same unique child lifecycle; no
second worker tracker or new authority is created. Legacy SessionStart identity
compatibility remains isolated from the stricter native child event contract.

Final Windows release checks passed 139/139. Stable Linux checks passed 138 with
zero failures and one explicit host-native PowerShell capability skip; its shim
assertions pass on Windows. Build, scoped lint, syntax, generated mirrors and
independent review passed. Exact source and built file hashes qualify the Linux
candidate before and after testing. Runtime package and cache activation retain
preimages and verify the complete inventory delta. The reviewed plugin trust
entries were already present at final verification; no trust or permissions
were changed in that closure.

Publication verification uses each branch's configured remote. A prior empty
OMX lookup queried upstream origin instead of the user's fork; exact fork
advertisement resolved the diagnostic without rewriting Git history.

Center Geo parsed six scoped files with zero parse failures and unchanged
structural severity counts. Existing leads and graph uncertainty remain visible;
the scanner result is not a claim of zero possible defects. Windows fsync
warnings remain a limitation on physical durability claims.
