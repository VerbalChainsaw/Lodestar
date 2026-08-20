# Governance package

Lodestar carries the canonical source for `director-protocol`, `codeplan`,
`center-multigeometry`, `center-audit`, and `ladder-audit`, together with their
load-bearing references and assets. Use a specialized skill only when its trigger
applies; capability names describe workflows and are not separate products.

Canonical skill content is package data, not an external-file ownership claim.
Lodestar may read its own package source and compare it with an existing installed
copy through `lodestar skills verify`. It does not install, synchronize, replace,
migrate, back up, or remove skills in any client or harness directory.

The package also carries instruction templates under `assets/templates/`. Lodestar may
print those templates through `lodestar agents template`; it never applies them to a
repository or global agent file. Distribution and deliberate file placement belong to
the user or the native environment that owns the destination.

Toolchain guidance remains simple: repository discovery and tests use project-native
tools; Lodestar provides context and read-only canonical references; host integrations
remain thin transport adapters. Do not introduce another policy compiler, installer,
database, controller, or background process for these capabilities.
