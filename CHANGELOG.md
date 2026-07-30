# Changelog

All notable changes to Lodestar are documented here.

## Unreleased

## 0.4.4 - 2026-07-29

- Make exact `get`/`resolve` retrieval precede scoped `find` in the installed
  Codex contract.
- Make `put` share the audited rollback transaction, preserve locator health,
  protect generated ownership, and record prior/next hashes.
- Reject duplicate project IDs before legacy migration can collapse shards.
- Reject unknown CLI options and make refresh/profile dry runs non-mutating.
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
