#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
TARGETS = MANIFEST["distribution"]["targets"]
IGNORE = shutil.ignore_patterns(".git", ".gitignore", "__pycache__", "*.pyc", "*.pyo")
SAFE_BASENAME = "center-multigeometry"
FULL_EXPECTED = {
    "SKILL.md",
    "README.md",
    "AGENTS.md",
    "CHANGELOG.md",
    "manifest.json",
    "validate_skill.py",
    "install_skill.py",
    "evals/trigger-cases.json",
    "LICENSE",
}
TARGET_MODES = {target["id"]: target["mode"] for target in TARGETS}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normalized(path: Path) -> str:
    return path.resolve(strict=False).as_posix().rstrip("/")


def sync_tree(src: Path, dst: Path) -> None:
    for path in src.rglob("*"):
        if ".git" in path.parts or "__pycache__" in path.parts or path.name == ".gitignore" or path.suffix in {".pyc", ".pyo"}:
            continue
        rel = path.relative_to(src)
        out = dst / rel
        if path.is_dir():
            out.mkdir(parents=True, exist_ok=True)
        else:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(path.read_bytes())


def discovered_parent_roots() -> dict[str, Path]:
    home = Path.home()
    hermes_root = Path(os.environ.get("HERMES_SKILLS_ROOT", "C:/Hermes/skills" if os.name == "nt" else str(home / ".hermes" / "skills")))
    return {
        "hermes": hermes_root / "software-development",
        "mavis": home / ".mavis" / "skills",
        "opencode": home / ".config" / "opencode" / "skills",
        "claude": home / ".claude" / "skills",
        "codex": home / ".agents" / "skills",
    }


def target_path(target_id: str) -> Path:
    roots = discovered_parent_roots()
    if target_id not in roots:
        raise ValueError(f"unknown target id: {target_id}")
    return roots[target_id] / SAFE_BASENAME


def ensure_safe_target(target_id: str) -> Path:
    dst = target_path(target_id)
    expected_parent = discovered_parent_roots()[target_id]
    if dst.name != SAFE_BASENAME:
        raise ValueError(f"refusing to touch suspicious destination basename: {dst}")
    if normalized(dst.parent) != normalized(expected_parent):
        raise ValueError(f"refusing to touch unexpected parent for {target_id}: {dst.parent} != {expected_parent}")
    if len(dst.parts) < 3:
        raise ValueError(f"refusing to touch suspiciously short destination: {dst}")
    return dst


def backup_existing_tree(dst: Path, target_id: str, backup_dir: Path) -> Path:
    backup_dir = backup_dir.resolve(strict=False)
    if normalized(backup_dir).startswith(normalized(dst) + "/"):
        raise ValueError(f"backup dir may not live inside destination tree: {backup_dir}")
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = backup_dir / f"{target_id}-{stamp}"
    shutil.copytree(dst, backup_path, ignore=IGNORE)
    return backup_path


def verify_bundle_copy(dst: Path, mode: str) -> tuple[bool, str]:
    skill_path = dst / "SKILL.md"
    if not skill_path.exists():
        return False, "SKILL.md missing"
    if sha256(skill_path) != sha256(ROOT / "SKILL.md"):
        return False, "SKILL.md hash mismatch"
    if mode == "skill_md_only":
        names = sorted(p.name for p in dst.iterdir())
        if names != ["SKILL.md"]:
            return False, f"skill_md_only root contains extra files: {names}"
        return True, "SKILL.md only + hash match"

    actual = set()
    for path in dst.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(dst)
        if "__pycache__" in rel.parts or path.suffix in {".pyc", ".pyo"}:
            continue
        actual.add(rel.as_posix())
    if actual != FULL_EXPECTED:
        missing = sorted(FULL_EXPECTED - actual)
        extra = sorted(actual - FULL_EXPECTED)
        return False, f"file-set mismatch missing={missing} extra={extra}"

    proc = subprocess.run(
        [sys.executable, str(dst / "validate_skill.py"), "--portable"],
        cwd=dst,
        capture_output=True,
        text=True,
        timeout=300,
    )
    out = (proc.stdout + proc.stderr).strip()
    return proc.returncode == 0, out.splitlines()[-1] if out else "(no output)"


def copy_target(target: dict, dry_run: bool, backup_dir: Path | None) -> None:
    target_id = target["id"]
    mode = target["mode"]
    dst = ensure_safe_target(target_id)
    if dry_run:
        suffix = f" backup_dir={backup_dir}" if backup_dir else ""
        print(f"[dry-run] {target_id:8s} -> {dst} ({mode}){suffix}")
        return

    overlay = False
    if dst.exists():
        print(f"[rm] {target_id:8s} removing {dst}")
        if backup_dir is not None:
            backup_path = backup_existing_tree(dst, target_id, backup_dir)
            print(f"[backup] {target_id:8s} saved existing tree to {backup_path}")
        try:
            shutil.rmtree(dst)
        except OSError:
            overlay = True
            print(f"[warn] {target_id:8s} could not fully remove {dst}; falling back to overlay copy")

    dst.parent.mkdir(parents=True, exist_ok=True)
    if mode == "skill_md_only":
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "SKILL.md", dst / "SKILL.md")
    else:
        if overlay:
            dst.mkdir(parents=True, exist_ok=True)
            sync_tree(ROOT, dst)
        else:
            shutil.copytree(ROOT, dst, ignore=IGNORE)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Install center-multigeometry to local agent skill roots.")
    ap.add_argument("--dry-run", action="store_true", help="show target actions without copying")
    ap.add_argument("--root", choices=sorted(TARGET_MODES), help="install or verify a single target")
    ap.add_argument("--verify-only", action="store_true", help="verify existing targets without copying")
    ap.add_argument("--backup-dir", help="optional directory for backups before replacing an existing target")
    args = ap.parse_args(argv)

    selected = [t for t in TARGETS if not args.root or t["id"] == args.root]
    backup_dir = Path(args.backup_dir) if args.backup_dir else None
    print(f"[install_skill] dry_run={args.dry_run} verify_only={args.verify_only} roots={[t['id'] for t in selected]} backup_dir={backup_dir}")

    overall_ok = True
    for target in selected:
        target_id = target["id"]
        mode = target["mode"]
        dst = ensure_safe_target(target_id)
        if not args.verify_only:
            try:
                copy_target(target, args.dry_run, backup_dir)
            except (OSError, ValueError) as exc:
                overall_ok = False
                print(f"[FAIL] {target_id:8s} copy failed: {exc}")
                continue
        if args.dry_run:
            continue
        ok, msg = verify_bundle_copy(dst, mode)
        if ok:
            print(f"[ OK ] {target_id:8s} {dst} :: {msg}")
        else:
            overall_ok = False
            print(f"[FAIL] {target_id:8s} {dst} :: {msg}")

    print(f"[install_skill] done — overall {'OK' if overall_ok else 'FAILED'}")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
