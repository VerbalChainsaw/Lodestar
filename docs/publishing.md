# Publishing Lodestar

`package.json` owns the package and landing-page version. Keep the generic Codex plugin
manifest, changelog, release notes, and installation examples aligned with it.
`docs/README.md` lists current documentation; label retained design plans as
historical so they cannot be mistaken for operating instructions.

## Package release

1. Run `npm test`, `npm run pack:check`, and `node scripts/build-site.mjs`.
   For Loader, build the Windows ZIP with `desktop/scripts/Build-Release.ps1`
   and run the native service and extracted-distribution checks documented in
   [desktop development](../desktop/README.md). Review installation commands,
   capability/error guidance and public claims against the exact candidate.
2. Merge a reviewed release branch through the required Windows, Linux, macOS,
   and CodeQL checks. Confirm the final version and release notes on `main`.
3. Create and push the matching `v<version>` tag on that verified commit. Release
   tags are immutable; inspect the target before creating one.
4. The `release` workflow repeats the tests and packed executable checks, publishes
   the exact tarball to npm with provenance, verifies registry integrity, and
   publishes the GitHub release with the core tarball, verified Windows ZIP,
   separate native Codex archive and their SHA-256 checksums. The Windows archive
   comes from the checked desktop job and is compared with that job's originating
   checksum. The exact publication tarball and native archive receive packed
   smoke checks before npm publishing.
5. Confirm the workflow completed, npm exposes the intended version, and the
   downloaded release tarball matches both registry integrity and the checksum.
   Verify the downloaded Windows and native archives against that same checksum file.

The plugin root is the complete package root, with `.codex-plugin/plugin.json`
and `.mcp.json` at that level. The packed smoke must copy the declared plugin root
to an isolated cache and execute its MCP requests without source/runtime overrides.
Running the adapter inside the original npm tree does not prove cached installation.

An existing npm version is accepted only when its integrity matches the newly
packed artifact. A rerun must not replace a package with different bytes.

## Native Codex adapter

`native-codex/` is the maintained source for the separate native plugin;
`native-codex/.codex-plugin/plugin.json` owns its independent version. The current
candidate pair is native **1.4.7** with core **3.0.1**. Keep the generic package-root
plugin's hooks-free contract. Neither the native archive nor its tests belong in
the core npm payload.

Both plugin skill trees are generated from `managed-assets/skills/lodestar` by the
existing assets builder. Edit that canonical skill, regenerate with the verified
Golden source root as described in `AGENTS.md`, then run `npm test`; do not maintain
another handwritten native skill copy. Increment the native version when its
shipped payload changes and record the core version used for qualification.

Build `lodestar-native-codex-<adapter-version>.tgz` using
`node scripts/build-native-codex.mjs <new-output-directory>`. Qualify its extracted
cache against the exact installed candidate core using
`node scripts/smoke-native-codex.mjs <native-archive.tgz> <packed-core/lodestar.mjs>`.
This executes native lifecycle, JSON admission, transport and compaction fixtures
through the separate core. Record both archive hashes, versions and outcomes.
The cross-platform workflow runs this native gate on Windows; the release workflow
also checks its exact native publication archive before uploading it.

The desktop workflow covers native service checks, extracted distribution setup,
installer lifecycle, distribution fault handling and the external database
boundary. These checks use disposable stores and host fixtures. They do not prove
natural Desktop hook delivery or visual acceptance. Record those separately when
claimed. Preserve existing marketplace/plugin identities and data on upgrades;
see [native installation](installation.md#native-codex-adapter).

## Landing page

The `landing-page` workflow follows a successful `release` workflow. It checks out
that release's commit and confirms its advertised package version is available on
npm before deploying to GitHub Pages. A failed release cannot launch the page.

For a site-only correction after release, merge the change through normal checks
and run **landing-page** manually on `main` in GitHub Actions, or use:

```text
gh workflow run pages.yml --repo VerbalChainsaw/Lodestar --ref main
```

Manual deployments are restricted to `main` and also verify the package version.
If `main` has advanced to an unpublished version, publish that version before
advertising it on the site. After deployment, inspect the public page at desktop
and mobile widths, check the install command and documentation links, and confirm
the shared hero image loads. Source builds alone do not verify the deployed site.

The site uses plain HTML and CSS. `scripts/build-site.mjs` substitutes the version
from `package.json`, copies the shared artwork, and exports static reference pages
from the canonical Markdown guides. Those pages retain complete escaped source
text, working local guide links and heading anchors, and exact-byte Markdown
downloads. Code and unsupported formatting remain visible. Edit the canonical
Markdown and rebuild; there is no separately authored site documentation body or
site runtime dependency. The same current-guide paths work in previews and public
deployment; archive/tag/npm actions keep their publication qualifications.
