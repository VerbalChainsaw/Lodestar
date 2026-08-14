#!/usr/bin/env python3
"""Create a portable Agent Skill ZIP with one top-level folder and POSIX paths."""

from __future__ import annotations

import argparse
import hashlib
import sys
import zipfile
from pathlib import Path

from validate_skill import validate_skill

SKIP_PARTS = {"__pycache__", ".git", ".DS_Store"}


def should_include(path: Path, root: Path, output: Path) -> bool:
    if path.resolve() == output.resolve():
        return False
    rel = path.relative_to(root)
    return not any(part in SKIP_PARTS for part in rel.parts)


def package(root: Path, output: Path) -> None:
    root = root.resolve()
    output = output.resolve()

    errors, warnings = validate_skill(root)
    for warning in warnings:
        print(f"WARNING: {warning}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        raise SystemExit("Refusing to package an invalid skill")

    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(root.rglob("*")):
            if not path.is_file() or not should_include(path, root, output):
                continue
            rel = path.relative_to(root).as_posix()
            arcname = f"{root.name}/{rel}"
            archive.write(path, arcname)

    with zipfile.ZipFile(output) as archive:
        names = archive.namelist()
        if not names:
            raise SystemExit("Created ZIP is empty")
        if any("\\" in name for name in names):
            raise SystemExit("Created ZIP contains nonportable backslash paths")
        top_levels = {name.split("/", 1)[0] for name in names}
        if top_levels != {root.name}:
            raise SystemExit(f"ZIP must contain exactly one top-level folder: {root.name}")
        if f"{root.name}/SKILL.md" not in names:
            raise SystemExit("ZIP is missing top-level SKILL.md")

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(f"Packaged: {output}")
    print(f"SHA256:   {digest}")


def main() -> int:
    default_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path, default=default_root)
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        default=None,
        help="Output ZIP path (default: sibling <skill-name>.zip)",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    output = args.output or root.parent / f"{root.name}.zip"
    package(root, output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
