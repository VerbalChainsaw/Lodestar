# Publishing Lodestar

`package.json` owns the package and landing-page version. Keep the Codex plugin
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
   publishes the GitHub release with the tarball, verified Windows ZIP and their
   SHA-256 checksums. The Windows archive comes from the checked desktop job;
   the exact publication tarball receives a packed smoke before npm publishing.
5. Confirm the workflow completed, npm exposes the intended version, and the
   downloaded release tarball matches both registry integrity and the checksum.
   Verify the downloaded Windows archive against that same checksum file.

The plugin root is the complete package root, with `.codex-plugin/plugin.json`
and `.mcp.json` at that level. The packed smoke must copy the declared plugin root
to an isolated cache and execute its MCP requests without source/runtime overrides.
Running the adapter inside the original npm tree does not prove cached installation.

An existing npm version is accepted only when its integrity matches the newly
packed artifact. A rerun must not replace a package with different bytes.

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
