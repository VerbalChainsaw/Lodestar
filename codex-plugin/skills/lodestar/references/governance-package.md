# Governance package

Lodestar installs the complete owned governance set: `director-protocol`,
`codeplan`, `center-multigeometry`, `center-audit`, and `ladder-audit`, together
with their references, examples, evaluators, scripts, licenses, and templates.
Use a specialized skill only when its trigger applies; capability names describe
workflows and are not separate products.

The package includes repository, host, and persona templates under
`assets/templates/`. Its source transformation manifest records exact copies,
intentional product-name rewrites, folded advisory-presence guidance, and the
small number of excluded generated cache files. Verification checks file-level
hashes, not directory counts.

Toolchain guidance remains simple: repository discovery and tests use the
project's native tools; Lodestar provides context and managed instructions; host
plugins remain thin one-shot adapters. Do not introduce another installer,
database, controller, or background process for these capabilities.
