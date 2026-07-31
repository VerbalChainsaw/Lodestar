# Lodestar 1.0 release codeplan

Date: 2026-07-31

Branch: `LodestarLite`

Release candidate baseline: `0caebd3`

## Objective

Publish the completed LodestarLite reduction as Lodestar 1.0.0 through one
auditable path:

1. validate the exact source and npm artifact locally;
2. validate the branch on hosted Linux, macOS, and Windows runners;
3. merge the reviewed branch to `main`;
4. create annotated tag `v1.0.0` at the merged release commit;
5. publish `lodestar-agent-context@1.0.0` publicly to npm;
6. publish the same tarball and checksum as the GitHub release;
7. verify both public surfaces from a clean consumer environment.

The release does not add runtime behavior, dependencies, executables, or
compatibility layers.

## Confirmed pre-release gaps

| ID | Gap | Closure |
| --- | --- | --- |
| R-01 | The tag workflow creates a GitHub release but never publishes to npm. | Publish the already-built tarball only after CodeQL and all three hosted operating-system jobs pass. |
| R-02 | The npm package name is currently unclaimed, so the first publication requires authenticated package creation. | Authenticate the owner, install a narrowly scoped GitHub release secret for the bootstrap publish, then configure npm trusted publishing and retire the bootstrap token after 1.0.0. |
| R-03 | The release job is not safely rerunnable after npm accepts a package but the workflow later fails. | Compare the registry integrity with the local packed integrity before publishing and after any ambiguous failure; accept only an exact match. |
| R-04 | The GitHub release body uses the entire changelog instead of version-specific notes. | Add `docs/releases/v1.0.0.md`, require the tag-specific file, and use it as the release body. |
| R-05 | The README identifies the executable but does not tell a new user how to install the npm package. | Add the exact global installation command before quick start. |
| R-06 | Release metadata still says `Unreleased`. | Date the 1.0.0 changelog entry at the release commit. |
| R-07 | Local GitHub and npm credentials are expired or absent. | Complete interactive owner authentication without recording credentials in the repository or command output. |

## Release workflow contract

The tag workflow must:

- require `v<package-version>` and a matching version-specific release note;
- require the tagged commit to belong to `origin/main`;
- use the exact Node.js 24.15.0 baseline and the bundled npm 11 client;
- run the complete test and package gates before publication;
- build the npm tarball once and retain its SHA-256 and npm integrity;
- publish that tarball with public access and npm provenance;
- treat an existing version as success only when registry integrity is exactly
  equal to the locally built artifact;
- attest and attach that same tarball plus `SHA256SUMS.txt` to GitHub;
- be safely rerunnable when npm or GitHub publication already completed.

No npm token is written to the repository. The bootstrap release credential is
stored only as an encrypted GitHub Actions secret and is removed after npm
trusted publishing is configured for `.github/workflows/release.yml`.

## Verification gates

Before tagging:

- exact Node.js 24.15.0 full 80-test suite and coverage;
- syntax, YAML, dependency-tree, package-manifest, and forbidden-runtime scans;
- two byte-identical packs;
- installed-tarball execution of all nine commands and ten help paths;
- read-only database byte and directory stability;
- genuine v0.7 dry-run and committed import with unchanged source hashes;
- `npm publish --dry-run --ignore-scripts --json`;
- hosted branch CI and CodeQL green on Linux, macOS, and Windows.

After publication:

- npm reports version 1.0.0 under `latest`;
- npm registry integrity equals the tagged tarball integrity;
- a clean `npm install --global lodestar-agent-context@1.0.0` exposes only
  `lodestar`;
- the installed executable initializes, writes, retrieves, diagnoses, exports,
  and preserves read-only database bytes;
- GitHub release `v1.0.0` points to the release commit and contains the same
  tarball plus a matching SHA-256 file;
- the repository default branch contains the release commit and remains clean.

## Human authorization points

Two owner actions cannot be inferred or automated:

1. approve GitHub and npm authentication;
2. confirm the permanent public package identity and version before the first
   registry publication.

Everything else is executed and verified from the repository evidence.
