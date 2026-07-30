# Changelog

All notable changes to Lodestar are documented here.

## Unreleased

## 0.6.1 - 2026-07-30

- Remove stale release-candidate and publication-pending language from the
  public README and release notes.
- State the supported provenance-attested GitHub tarball distribution path
  explicitly instead of implying that the package is available from the npm
  registry.
- Normalize package `bin` targets so npm does not rewrite the public metadata
  during publication checks.
- Add a public vulnerability-reporting policy and Dependabot coverage for npm
  metadata and GitHub Actions.
- Add conventional help output to all three public benchmark executables.
- Refresh the paired retrieval and full 10/100/500-project performance evidence
  without changing the v0.6 store format or context behavior.

## 0.6.0 - 2026-07-30

- Seal new generations with deterministic SHA-256 manifests and add deep doctor
  verification of the complete file set, file bytes, canonical generation
  identity, and rebuilt index content while retaining explicit compatibility
  with legacy unsealed generations.
- Synchronize staged generation, pointer, audit, initialization, snapshot, and
  restore data before promotion, clean complete transaction roots after
  pre-commit failures, and report post-commit durability uncertainty without
  falsely reporting an unchanged destination.
- Enforce versioned record, catalog, graph, shard, and store resource limits
  before persistence or index construction, including the measured 500-project
  boundary.
- Add portable, independently checksummed snapshots and fail-closed
  restore-to-new-home validation.
- Add dry-run-first maintenance with storage telemetry, bounded generation
  retention, recoverable quarantine rollback, exact preview/apply targets,
  hashed audit-log rotation, and bounded source-drift detection.
- Close the adversarial release gate with portable shard collision checks,
  physical locator and destination confinement, composite maintenance rollback,
  complete rotated-audit snapshots, bounded input/archive/index processing,
  installer-wide recovery, immutable CI action pins, CodeQL, and artifact
  provenance attestations.
- Add `agentctx recover <generation> [--promote]` for validated, audited
  quarantine recovery without an irreversible purge surface.
- Keep irreversible quarantine purge and public schema migration out of the
  release until each has a complete, independently proven product contract.
- Add required-file corruption, manifest-omission, partial-write, disk-sync,
  copy-failure, retention-rollback, snapshot, drift, resource-boundary, and
  packed lifecycle regression coverage.
- Complete the release-polish pass with conventional CLI and installer
  help/version surfaces, WSL translation for cataloged Windows roots during
  physical locator checks, and one authoritative doctor issue per unhealthy
  locator.

## 0.5.0 - 2026-07-30

- Make the default project-registry migration a lossless, previewable merge
  instead of refusing populated stores or requiring destructive replacement.
- Preserve immutable Lodestar project IDs across repeat imports while failing
  closed on ambiguous identity matches.
- Store descriptions, lifecycle facts, commands, entrypoints, endpoints, and
  memory anchors in bounded linked portfolio records, with only one compact
  card added to startup.
- Reject unsupported registry fields instead of silently dropping data.
- Make unchanged repeat imports true no-ops that do not create a generation or
  audit event, while retaining the legacy `--force` replacement path.
- Add freshness-aware project readiness with `ready`, `incomplete`, `stale`,
  and `blocked` states plus `coverage --require-ready` for automation.
- Surface incomplete, stale, and unverified project context through `doctor`
  as actionable maintenance warnings.
- Add an implementation decision record and real-registry, idempotence,
  preservation, error-path, readiness, and package regression coverage.

- Build a full product front page around Lodestar's theory, origin, operating
  role, engineering depth, agent workflow, and public release path.
- Add a standalone transparent Lodestar product mark and a panoramic linked-
  context hero illustration.
- Add a paired, machine-readable material-lift benchmark that compares broad
  repository discovery with real Lodestar `start` plus linked `resolve`,
  documents its claim boundary, and runs from the packed Windows/WSL package.
- Add small, standard, and 500-project stress profiles plus fresh/warm
  operation-level p50/p95 measurements and observational memory reporting.
- Add a provider-neutral live-agent category benchmark with realistic ambiguous,
  tiny-direct, and stale-context fixtures; paired randomized trials; leakage,
  confidence, reproducibility, and search-efficiency scoring; retained raw
  evidence; resumable runs; and explicit no-spend, cost-cap, timeout, and STOP
  boundaries.
- Add a read-only Codex `exec --json` adapter, a deterministic protocol
  self-test adapter, a public benchmark methodology, and a preregistered plan
  that requires publishing neutral and losing cases.

## 0.4.4 - 2026-07-29

- Make exact `get`/`resolve` retrieval precede scoped `find` in the installed
  Codex contract.
- Make `put` share the audited rollback transaction, preserve locator health,
  protect generated ownership, and record prior/next hashes.
- Reject duplicate project IDs before legacy migration can collapse shards.
- Reject unknown CLI options and make refresh/profile dry runs non-mutating.
- Validate required exact-lookup and `ask` arguments before opening the state
  store so clean installations return actionable input errors.
- Deduplicate Windows/WSL roots by physical identity and recheck discovery
  candidates inside the writer lock.
- Add fail-closed standalone doctor diagnostics and explicit current-pointer and
  stale-lock repair commands.
- Add guided initialization and a deterministic 100-project material-lift gate.
- Validate tarball identity before npm, suppress lifecycle scripts, use the
  validated Node executable in Windows shims, and restore the previous package
  when post-install setup fails.
- Make package-install smoke checks derive the tarball name from package
  metadata so release version bumps cannot leave CI wired to an older artifact.

## 0.4.3 - 2026-07-29

- License the public package under the MIT License.
- Add complete installation, Windows/WSL, authoring, troubleshooting, and
  release documentation.
- Add an automated, checksum-producing GitHub release workflow.
- Replace an invalid stale-lock repair command with accurate recovery guidance.
- Retain the hardened cross-platform installer, immutable store generations,
  scoped linked retrieval, legacy-store migration, project profiling, Codex
  integration, and rollback support delivered in the 0.4 series.

## 0.4.2 - 2026-07-29

- Translate cataloged Windows roots in WSL diagnostics.
- Harden native Windows prefix-bin compatibility shims.
- Validate the package on native Windows, WSL, Linux, and macOS.

## 0.4.1 - 2026-07-29

- Harden the installer and Windows/WSL error handling.
- Preserve existing stores and Codex instructions during installation.

## 0.4.0 - 2026-07-29

- Publish the linked-context MVP with stable record IDs, deterministic indexes,
  bounded graph resolution, locator health, and transactional writes.
- Restore universal project migration, profiling, doctor, rollback, inventory,
  coverage, and context-query functionality.
