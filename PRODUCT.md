# Lodestar Loader and Manager
<!-- impeccable:product-schema 1 -->

## Platform

Windows desktop (native WPF); companion terminal interface.

## Stack

Architecture delegated by the Director: existing .NET 10 / WPF and installed Node/Lodestar. No new dependency installation. Choice and alternatives are recorded in [the retained architecture record](../../outputs/lodestar-project-records/REJECTED-ARCHITECTURES.md).

## Users and purpose

The Director needs to see what projects exist, when Lodestar recorded updates, the latest recorded status, activity, evidence and history, and make their own corrections. The two requested interfaces are Lodestar Loader (LL), a separate polished desktop program, and Lodestar Manager (LM), menu-driven terminal functions in Lodestar.

## Operating context

Windows, local data, many development projects, concurrent agent updates. The existing Lodestar executable, universal records and guarded writes remain authoritative. Recent DeepSeek updates must be preserved and used as baseline.

## Product principles

- Open and close without a service, installer, or cleanup ritual.
- Show the origin and meaning of status and time; missing facts remain missing.
- Guard human corrections against concurrent changes and preserve history.
- Discover shared capabilities from the core rather than drift between two menus.
- Keep browsing fast through background reads, in-memory filtering and lazy details.

## Evidence and limits

Initial discovery recorded 134 catalog project records; counts can change. No universal project status exists. Recorded updates differ from filesystem changes and current worker liveness. Original interaction and performance evidence is in [the retained verification record](../../outputs/lodestar-project-records/VERIFICATION.md), with its original open items in [the retained checkpoint](../../outputs/lodestar-project-records/OPEN-ITEMS.md). Those records describe their dated snapshot. Current product guidance is in [the documentation index](docs/README.md); current delivery disposition is in [the release record](../../outputs/RELEASE-PLAN.md).

## Accessibility

Native keyboard interaction, visible focus, accessible control labels, color plus text status, readable density, resizing and high-DPI layout.

## Operator-console redesign, confirmed 2026-09-28

The Director requests a dense, elegant, feature-rich operator console with sortable/groupable lists, resizable panels, a readable translation of stored records and usable editors. Health covers Lodestar only; do not collect general PC CPU/memory/disk telemetry. Appearance is dark graphite with restrained accents. Preserve native Windows operation, public CLI boundaries, conflict-safe writes and all prior working functions. The Director also authorized all H01-H06 hardening items. Product truth is mirrored to the user-facing outputs/PRODUCT.md at handoff; this source copy is the build/design working record.
