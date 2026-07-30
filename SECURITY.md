# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.6.x | Yes |
| Earlier versions | No |

Security fixes are released from the current `0.6.x` line. Upgrade to the
latest published patch before reporting behavior that may already be fixed.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability.

Use
[GitHub private vulnerability reporting](https://github.com/VerbalChainsaw/Lodestar/security/advisories/new)
and include:

- the affected Lodestar version and platform;
- the smallest reproduction you can provide;
- the security impact and required attacker capabilities;
- whether the issue affects local state, installation, snapshots, release
  artifacts, or repository automation; and
- any suggested mitigation.

Reports will be acknowledged as soon as practical. Confirmed issues will be
handled privately until a fix and coordinated disclosure are ready.

## Security boundary

Lodestar is local-first and has no runtime service or telemetry. Its integrity
manifests detect accidental corruption and inconsistent state; they are not an
authenticity guarantee against an attacker who can rewrite the complete local
store. Release packages provide a separate SHA-256 checksum and GitHub SLSA
provenance attestation.
