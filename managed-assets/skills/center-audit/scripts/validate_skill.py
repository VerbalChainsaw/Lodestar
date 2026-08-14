#!/usr/bin/env python3
"""Validate a CENTER-AUDIT Agent Skill bundle using only the Python standard library."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
# Match references to in-bundle resources by path with any extension — no
# extension whitelist. Any file referenced via `references/`, `scripts/`,
# `assets/`, or `evals/` relative path is checked for existence on disk.
# This is intentional: the validator should catch missing .toml, .proto,
# .sql, .prisma, .env.example, .txt, or any other file a reference doc
# happens to point at. Extension filtering silently passed through missing
# files in v2.0.x — see CHANGELOG v2.5.0 "Validator: extension-whitelist
# regex replaced with path-only match".
#
# The negative lookbehind `(?<![A-Za-z0-9_./-])` excludes any path-shaped
# character (including `/`) so the regex does not match inside URLs. A URL
# like `https://example.com/references/foo.md` was a v2.5.0 false-positive
# (the lookbehind excluded `.` and `-` but not `/`); v2.5.1 excludes `/`
# too. Trade-off: nested paths like `subdir/references/foo.md` are no longer
# validated. In an Agent Skills bundle, nested skill-root paths would violate
# the bundle structure anyway, so this trade-off is acceptable.
#
# The trailing extension requirement (`\.[A-Za-z0-9]+`) prevents
# over-matching into adjacent prose words. Example: the phrase
# "definition/references/call hierarchy" must NOT be parsed as the resource
# "references/call" — `call` is not followed by `.ext`, so the match fails.
RESOURCE_RE = re.compile(r"(?<![A-Za-z0-9_./-])((?:references|scripts|assets|evals)/[A-Za-z0-9_./-]*\.[A-Za-z0-9]+)")


def _parse_scalar(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def read_frontmatter(skill_md: Path) -> tuple[dict[str, str], str]:
    text = skill_md.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("SKILL.md must begin with YAML frontmatter delimiter '---'")

    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        raise ValueError("SKILL.md frontmatter has no closing '---' delimiter")

    metadata: dict[str, str] = {}
    for line in lines[1:end]:
        if not line or line[0].isspace() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, raw = line.split(":", 1)
        metadata[key.strip()] = _parse_scalar(raw)

    body = "\n".join(lines[end + 1 :]).strip()
    return metadata, body


def _find_skill_files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.name.lower() == "skill.md"
    )


def _resource_references(root: Path) -> set[str]:
    refs: set[str] = set()
    for md in root.rglob("*.md"):
        text = md.read_text(encoding="utf-8")
        for match in RESOURCE_RE.finditer(text):
            ref = match.group(1).rstrip(".,;:)]}'\"`")
            refs.add(ref)
    return refs


def validate_skill(root: Path) -> tuple[list[str], list[str]]:
    root = root.resolve()
    errors: list[str] = []
    warnings: list[str] = []

    if not root.is_dir():
        return [f"Skill root does not exist or is not a directory: {root}"], warnings

    skill_files = _find_skill_files(root)
    if len(skill_files) != 1:
        errors.append(f"Expected exactly one SKILL.md (case-insensitive); found {len(skill_files)}")
        if not skill_files:
            return errors, warnings

    skill_md = skill_files[0]
    if skill_md.parent != root:
        errors.append(f"SKILL.md must be at the skill root, found at {skill_md.relative_to(root)}")

    try:
        meta, body = read_frontmatter(skill_md)
    except (OSError, UnicodeError, ValueError) as exc:
        errors.append(str(exc))
        return errors, warnings

    name = meta.get("name", "")
    description = meta.get("description", "")
    compatibility = meta.get("compatibility", "")

    if not name:
        errors.append("Frontmatter field 'name' is required")
    else:
        if len(name) > 64:
            errors.append(f"Skill name exceeds 64 characters ({len(name)})")
        if not NAME_RE.fullmatch(name):
            errors.append("Skill name must use lowercase letters, numbers, and single hyphens")
        if name != root.name:
            errors.append(f"Skill name '{name}' must match parent directory '{root.name}'")

    if not description:
        errors.append("Frontmatter field 'description' is required")
    elif len(description) > 1024:
        errors.append(f"Description exceeds 1024 characters ({len(description)})")

    if compatibility and len(compatibility) > 500:
        errors.append(f"Compatibility exceeds 500 characters ({len(compatibility)})")

    if not body:
        errors.append("SKILL.md body is empty")

    line_count = len(skill_md.read_text(encoding="utf-8").splitlines())
    if line_count > 500:
        warnings.append(f"SKILL.md has {line_count} lines; Agent Skills recommends fewer than 500")

    for ref in sorted(_resource_references(root)):
        target = root / ref
        if not target.exists():
            errors.append(f"Referenced resource does not exist: {ref}")

    json_docs: dict[Path, Any] = {}
    for json_path in sorted(root.rglob("*.json")):
        try:
            json_docs[json_path] = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            errors.append(f"Invalid JSON in {json_path.relative_to(root)}: {exc}")

    eval_path = root / "evals" / "trigger-cases.json"
    if eval_path.exists() and eval_path in json_docs:
        cases = json_docs[eval_path]
        if not isinstance(cases, list):
            errors.append("evals/trigger-cases.json must be a JSON array")
        else:
            positives = 0
            negatives = 0
            for index, case in enumerate(cases):
                if not isinstance(case, dict):
                    errors.append(f"Trigger case {index} must be an object")
                    continue
                if not isinstance(case.get("query"), str) or not case["query"].strip():
                    errors.append(f"Trigger case {index} needs a non-empty string 'query'")
                if not isinstance(case.get("should_trigger"), bool):
                    errors.append(f"Trigger case {index} needs boolean 'should_trigger'")
                elif case["should_trigger"]:
                    positives += 1
                else:
                    negatives += 1
            if len(cases) < 8:
                warnings.append("Trigger eval set has fewer than 8 cases")
            if positives == 0 or negatives == 0:
                errors.append("Trigger eval set must include both positive and negative cases")

    schema_path = root / "assets" / "center-audit-output.schema.json"
    if schema_path.exists() and schema_path in json_docs:
        schema = json_docs[schema_path]
        version = schema.get("properties", {}).get("schema_version", {}).get("const")
        metadata_version = ""
        text = skill_md.read_text(encoding="utf-8")
        version_match = re.search(r'^\s{2}version:\s*["\']?([^"\'\n]+)', text, re.MULTILINE)
        if version_match:
            metadata_version = version_match.group(1).strip()
        if metadata_version and version != metadata_version:
            errors.append(
                f"Output schema version '{version}' does not match skill metadata version '{metadata_version}'"
            )

    forbidden = [p for p in root.rglob("*") if "\\" in p.name]
    if forbidden:
        errors.append("Resource names must not contain backslashes")

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "root",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Path to the skill root (default: parent of scripts/)",
    )
    args = parser.parse_args()

    errors, warnings = validate_skill(args.root)
    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")

    if errors:
        print(f"Validation failed with {len(errors)} error(s).")
        return 1

    print(f"Skill validation passed: {args.root.resolve()}")
    if warnings:
        print(f"Warnings: {len(warnings)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
