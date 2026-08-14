#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import py_compile
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))


def discover_app_root() -> Path:
    candidates: list[Path] = []
    configured = os.environ.get("CENTER_GEO_ROOT")
    if configured:
        candidates.append(Path(configured).expanduser().resolve())

    cli = shutil.which("center-geo") or shutil.which("center-geo.exe")
    if cli:
        resolved_cli = Path(cli).resolve()
        if resolved_cli.name in {"main.js", "main.cjs", "main.mjs"} and resolved_cli.parent.name == "cli":
            candidates.append(resolved_cli.parents[2])

    candidates.append((ROOT / MANIFEST.get("app_root", "../..")).resolve())
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "package.json").is_file():
            return candidate
    return candidates[0]


REPO_ROOT = discover_app_root()
APP_ROOT = REPO_ROOT
REQUIRED_FILES = [
    "SKILL.md",
    "README.md",
    "AGENTS.md",
    "CHANGELOG.md",
    "manifest.json",
    "validate_skill.py",
    "install_skill.py",
    "evals/trigger-cases.json",
    "LICENSE",
]
REQUIRED_HEADINGS = [
    "## When to Use",
    "## Actual Tool Surface Today",
    "## Required Workflow",
    "## Reporting Rules",
    "## Agent Handoff Packet",
    "## Exit Codes",
    "## Verification Checklist",
]
REQUIRED_STOPS = [
    "### Stop 0 - Scan frame",
    "### Stop 1 - Build or use the built artifact",
    "### Stop 2 - Coverage check",
    "### Stop 3 - Geometry review",
    "### Stop 4 - Hypothesis triage",
    "### Stop 5 - Produce the handoff packet",
    "### Stop 6 - Compare against a baseline when needed",
]
REQUIRED_PHRASES = [
    "These are structural risk hypotheses derived from graph evidence. They are not confirmed defects until reproduced or proven by a focused audit.",
    "Do not invent `graph`, `run`, `inspect`, or `validate` commands",
    "Use CENTER-MULTIGEOMETRY to choose the next case. Use CENTER-AUDIT to prove it.",
]
EXPECTED_TOP_KEYS = {
    "schema_version",
    "tool_version",
    "scan_frame",
    "count",
    "raw_signal_count",
    "coverage",
    "engine_runs",
    "signals",
    "hypotheses",
    "warnings",
}
EXPECTED_DIFF_KEYS = {
    "schema_version",
    "base_path",
    "head_path",
    "base_count",
    "head_count",
    "new_hypotheses",
    "resolved_hypotheses",
    "changed_hypotheses",
    "unchanged_count",
}
EXPECTED_REPORT_FILES = {"report.json", "report.md", "report.sarif"}
EXPECTED_TARGETS = {
    "hermes": "skill_md_only",
    "mavis": "skill_md_only",
    "opencode": "full",
    "claude": "full",
    "codex": "full",
}
EXPECTED_COVERAGE_KEYS = {
    "edges_low_confidence",
    "edges_total",
    "files_failed",
    "files_indexed",
    "files_parsed",
    "files_seen",
    "files_skipped",
    "generated_files",
    "graph_build_ms",
    "nodes_total",
    "parse_failure_paths",
    "parse_ms",
    "unsupported_files",
}
EXPECTED_GEOMETRY_IDS = {"radial", "cycle", "boundary", "anomaly", "convergent", "path"}
EXPECTED_SIGNAL_KEYS = {
    "id",
    "geometry_id",
    "type",
    "target",
    "severity_hint",
    "confidence_hint",
    "evidence",
    "metrics",
    "explanation",
    "limitations",
}
EXPECTED_HYPOTHESIS_KEYS = {
    "id",
    "title",
    "status",
    "target",
    "targetId",
    "targetKind",
    "maxSeverity",
    "score",
    "contributors",
    "contributing_signal_ids",
    "contributing_geometries",
    "components",
    "contradictions",
    "limitations",
    "investigation_packet",
    "explanation",
    "edgeKinds",
    "geometries",
}
EXPECTED_SCORE_KEYS = {
    "rank_score",
    "severity",
    "confidence",
    "geometry_count",
    "evidence_count",
    "independence_count",
    "calculation_notes",
}
EXPECTED_INVESTIGATION_KEYS = {
    "objective",
    "suspected_invariant",
    "suggested_center_anchors",
    "first_questions",
    "forbidden_scope",
    "recommended_verification",
}
SEVERITIES = {"low", "medium", "high", "critical"}
CONFIDENCES = {"low", "medium", "high"}
NODE_BIN = shutil.which("node") or shutil.which("node.exe") or r"C:/Program Files/nodejs/node.exe"
NPM_BIN = shutil.which("npm.cmd") or shutil.which("npm") or r"C:/Program Files/nodejs/npm.cmd"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def resolve_manifest_path(value: object) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(value)
    if path.is_absolute():
        return path
    candidates = [(ROOT / path).resolve(), (APP_ROOT / path).resolve()]
    if "docs" in path.parts:
        docs_index = path.parts.index("docs")
        candidates.append((APP_ROOT / Path(*path.parts[docs_index:])).resolve())
    return next((candidate for candidate in candidates if candidate.exists()), candidates[0])


def is_non_empty_str(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def is_non_negative_int(value: object) -> bool:
    return isinstance(value, int) and value >= 0


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    m = re.match(r"\A---\n(.*?)\n---\n(.*)\Z", text, re.S)
    if not m:
        raise ValueError("frontmatter block missing or malformed")
    front, body = m.group(1), m.group(2)

    out: dict[str, str] = {}
    for line in front.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and value and not line.startswith("  "):
            out[key] = value
    return out, body


def append_problem(problems: list[str], condition: bool, message: str) -> None:
    if not condition:
        problems.append(message)


def validate_python_script(rel_path: str, problems: list[str]) -> None:
    try:
        py_compile.compile(str(ROOT / rel_path), doraise=True)
    except py_compile.PyCompileError as exc:
        problems.append(f"python compile failed for {rel_path}: {exc.msg}")


def validate_anchor(anchor: object, label: str, problems: list[str]) -> None:
    if not isinstance(anchor, dict):
        problems.append(f"{label} must be an object")
        return
    append_problem(problems, is_non_empty_str(anchor.get("path")), f"{label}.path must be a non-empty string")
    append_problem(problems, is_non_empty_str(anchor.get("source")), f"{label}.source must be a non-empty string")
    range_obj = anchor.get("range")
    if not isinstance(range_obj, dict):
        problems.append(f"{label}.range must be an object")
        return
    append_problem(problems, is_non_negative_int(range_obj.get("start_line")), f"{label}.range.start_line must be a non-negative int")
    append_problem(problems, is_non_negative_int(range_obj.get("end_line")), f"{label}.range.end_line must be a non-negative int")


def validate_string_list(value: object, label: str, problems: list[str], *, non_empty: bool = False) -> None:
    if not isinstance(value, list):
        problems.append(f"{label} must be a list")
        return
    if non_empty and not value:
        problems.append(f"{label} must not be empty")
        return
    for index, item in enumerate(value):
        if not is_non_empty_str(item):
            problems.append(f"{label}[{index}] must be a non-empty string")


def validate_bundle() -> list[str]:
    problems: list[str] = []
    for rel in REQUIRED_FILES:
        if not (ROOT / rel).exists():
            problems.append(f"missing required file: {rel}")
    if problems:
        return problems

    skill_text = read(ROOT / "SKILL.md")
    manifest = json.loads(read(ROOT / "manifest.json"))
    trigger_cases = json.loads(read(ROOT / "evals/trigger-cases.json"))

    try:
        front, _body = parse_frontmatter(skill_text)
    except ValueError as exc:
        return [str(exc)]

    desc = front.get("description", "")
    append_problem(problems, front.get("name") == "center-multigeometry", "SKILL.md name must be center-multigeometry")
    append_problem(problems, manifest.get("name") == "center-multigeometry", "manifest name must be center-multigeometry")
    append_problem(problems, manifest.get("skill_name") == "center-multigeometry", "manifest skill_name must be center-multigeometry")
    append_problem(problems, manifest.get("category") == "software-development", "manifest category must be software-development")
    append_problem(problems, manifest.get("description") == desc, "manifest description must match SKILL.md description")
    if len(desc) > 60:
        problems.append(f"description too long for Hermes runtime cap: {len(desc)} > 60")

    append_problem(problems, is_non_empty_str(manifest.get("app_root")), "manifest app_root must be a non-empty string")
    spec_sources = manifest.get("spec_sources")
    if not isinstance(spec_sources, list) or not spec_sources:
        problems.append("manifest spec_sources must be a non-empty list")
    else:
        for index, spec_path in enumerate(spec_sources):
            if not is_non_empty_str(spec_path):
                problems.append(f"spec_sources[{index}] must be a non-empty path string")

    for heading in REQUIRED_HEADINGS:
        if heading not in skill_text:
            problems.append(f"missing heading in SKILL.md: {heading}")
    for stop in REQUIRED_STOPS:
        if stop not in skill_text:
            problems.append(f"missing workflow stop in SKILL.md: {stop}")
    for phrase in REQUIRED_PHRASES:
        if phrase not in skill_text:
            problems.append(f"missing required phrase in SKILL.md: {phrase}")

    targets = manifest.get("distribution", {}).get("targets", [])
    target_map = {item.get("id"): item.get("mode") for item in targets}
    if target_map != EXPECTED_TARGETS:
        problems.append(f"target ids/modes mismatch: {target_map}")

    if not isinstance(trigger_cases, list) or len(trigger_cases) < 8:
        problems.append("evals/trigger-cases.json must be a JSON array with at least 8 cases")
    else:
        positives = 0
        negatives = 0
        for index, case in enumerate(trigger_cases):
            if not isinstance(case, dict):
                problems.append(f"trigger case {index} must be an object")
                continue
            if not is_non_empty_str(case.get("query")):
                problems.append(f"trigger case {index} needs a non-empty string query")
            if not isinstance(case.get("should_trigger"), bool):
                problems.append(f"trigger case {index} needs boolean should_trigger")
                continue
            positives += int(case["should_trigger"])
            negatives += int(not case["should_trigger"])
        if positives == 0 or negatives == 0:
            problems.append("trigger cases must include both positive and negative examples")

    validate_python_script("validate_skill.py", problems)
    validate_python_script("install_skill.py", problems)
    return problems


def validate_local() -> list[str]:
    problems: list[str] = []
    append_problem(problems, APP_ROOT.exists(), f"app_root missing on disk: {APP_ROOT.as_posix()}")
    append_problem(problems, (APP_ROOT / "package.json").exists(), f"package.json missing at app_root: {(APP_ROOT / 'package.json').as_posix()}")
    for spec_path in MANIFEST.get("spec_sources", []):
        resolved = resolve_manifest_path(spec_path)
        if resolved is None or not resolved.exists():
            problems.append(f"missing spec source on disk: {spec_path}")
    return problems


def validate_scan_report(scan_obj: object, label: str) -> list[str]:
    problems: list[str] = []
    if not isinstance(scan_obj, dict):
        return [f"{label} must be a JSON object"]
    actual_keys = set(scan_obj.keys())
    if actual_keys != EXPECTED_TOP_KEYS:
        problems.append(f"{label} top-level keys mismatch: {sorted(actual_keys)}")
    append_problem(problems, is_non_empty_str(scan_obj.get("schema_version")), f"{label}.schema_version must be a non-empty string")
    append_problem(problems, is_non_empty_str(scan_obj.get("tool_version")), f"{label}.tool_version must be a non-empty string")
    append_problem(problems, isinstance(scan_obj.get("scan_frame"), dict), f"{label}.scan_frame must be an object")
    append_problem(problems, is_non_negative_int(scan_obj.get("count")), f"{label}.count must be a non-negative int")
    append_problem(problems, is_non_negative_int(scan_obj.get("raw_signal_count")), f"{label}.raw_signal_count must be a non-negative int")
    append_problem(problems, isinstance(scan_obj.get("warnings"), list), f"{label}.warnings must be a list")

    coverage = scan_obj.get("coverage")
    if not isinstance(coverage, dict):
        problems.append(f"{label}.coverage must be an object")
    else:
        coverage_keys = set(coverage.keys())
        if coverage_keys != EXPECTED_COVERAGE_KEYS:
            problems.append(f"{label}.coverage keys mismatch: {sorted(coverage_keys)}")
        for key in EXPECTED_COVERAGE_KEYS - {"parse_failure_paths"}:
            if not is_number(coverage.get(key)):
                problems.append(f"{label}.coverage.{key} must be numeric")
        if not isinstance(coverage.get("parse_failure_paths"), list):
            problems.append(f"{label}.coverage.parse_failure_paths must be a list")
        else:
            for index, item in enumerate(coverage["parse_failure_paths"]):
                if not is_non_empty_str(item):
                    problems.append(f"{label}.coverage.parse_failure_paths[{index}] must be a non-empty string")

    engine_runs = scan_obj.get("engine_runs")
    if not isinstance(engine_runs, list) or not engine_runs:
        problems.append(f"{label}.engine_runs must be a non-empty list")
    else:
        seen_geometries: set[str] = set()
        for index, run in enumerate(engine_runs):
            if not isinstance(run, dict):
                problems.append(f"{label}.engine_runs[{index}] must be an object")
                continue
            geometry_id = run.get("geometry_id")
            if not is_non_empty_str(geometry_id):
                problems.append(f"{label}.engine_runs[{index}].geometry_id must be a non-empty string")
            else:
                seen_geometries.add(str(geometry_id))
            append_problem(problems, is_non_empty_str(run.get("status")), f"{label}.engine_runs[{index}].status must be a non-empty string")
            append_problem(problems, is_non_negative_int(run.get("signal_count")), f"{label}.engine_runs[{index}].signal_count must be a non-negative int")
        if seen_geometries != EXPECTED_GEOMETRY_IDS:
            problems.append(f"{label}.engine_runs geometry set mismatch: {sorted(seen_geometries)}")

    signals = scan_obj.get("signals")
    if not isinstance(signals, list) or not signals:
        problems.append(f"{label}.signals must be a non-empty list")
    else:
        for index, signal in enumerate(signals):
            if not isinstance(signal, dict):
                problems.append(f"{label}.signals[{index}] must be an object")
                continue
            signal_keys = set(signal.keys())
            if signal_keys != EXPECTED_SIGNAL_KEYS:
                problems.append(f"{label}.signals[{index}] keys mismatch: {sorted(signal_keys)}")
            append_problem(problems, is_non_empty_str(signal.get("id")), f"{label}.signals[{index}].id must be a non-empty string")
            geometry_id = signal.get("geometry_id")
            append_problem(problems, is_non_empty_str(geometry_id), f"{label}.signals[{index}].geometry_id must be a non-empty string")
            if is_non_empty_str(geometry_id) and geometry_id not in EXPECTED_GEOMETRY_IDS:
                problems.append(f"{label}.signals[{index}].geometry_id unexpected: {geometry_id}")
            append_problem(problems, is_non_empty_str(signal.get("type")), f"{label}.signals[{index}].type must be a non-empty string")
            append_problem(problems, signal.get("severity_hint") in SEVERITIES, f"{label}.signals[{index}].severity_hint invalid")
            append_problem(problems, signal.get("confidence_hint") in CONFIDENCES, f"{label}.signals[{index}].confidence_hint invalid")
            append_problem(problems, isinstance(signal.get("metrics"), dict), f"{label}.signals[{index}].metrics must be an object")
            append_problem(problems, is_non_empty_str(signal.get("explanation")), f"{label}.signals[{index}].explanation must be a non-empty string")
            validate_string_list(signal.get("limitations"), f"{label}.signals[{index}].limitations", problems, non_empty=True)
            target = signal.get("target")
            if not isinstance(target, dict):
                problems.append(f"{label}.signals[{index}].target must be an object")
            else:
                append_problem(problems, is_non_empty_str(target.get("kind")), f"{label}.signals[{index}].target.kind must be a non-empty string")
            evidence = signal.get("evidence")
            if not isinstance(evidence, list) or not evidence:
                problems.append(f"{label}.signals[{index}].evidence must be a non-empty list")
            else:
                for evidence_index, anchor in enumerate(evidence):
                    validate_anchor(anchor, f"{label}.signals[{index}].evidence[{evidence_index}]", problems)

    hypotheses = scan_obj.get("hypotheses")
    if not isinstance(hypotheses, list) or not hypotheses:
        problems.append(f"{label}.hypotheses must be a non-empty list")
    else:
        for index, hypothesis in enumerate(hypotheses):
            if not isinstance(hypothesis, dict):
                problems.append(f"{label}.hypotheses[{index}] must be an object")
                continue
            hyp_keys = set(hypothesis.keys())
            if hyp_keys != EXPECTED_HYPOTHESIS_KEYS:
                problems.append(f"{label}.hypotheses[{index}] keys mismatch: {sorted(hyp_keys)}")
            for key in ["id", "title", "status", "targetId", "targetKind", "maxSeverity", "explanation"]:
                append_problem(problems, is_non_empty_str(hypothesis.get(key)), f"{label}.hypotheses[{index}].{key} must be a non-empty string")
            append_problem(problems, isinstance(hypothesis.get("target"), dict), f"{label}.hypotheses[{index}].target must be an object")
            validate_string_list(hypothesis.get("contributing_signal_ids"), f"{label}.hypotheses[{index}].contributing_signal_ids", problems, non_empty=True)
            validate_string_list(hypothesis.get("contributing_geometries"), f"{label}.hypotheses[{index}].contributing_geometries", problems, non_empty=True)
            validate_string_list(hypothesis.get("limitations"), f"{label}.hypotheses[{index}].limitations", problems, non_empty=True)
            if not isinstance(hypothesis.get("components"), dict):
                problems.append(f"{label}.hypotheses[{index}].components must be an object")
            else:
                for component_name, component_value in hypothesis["components"].items():
                    if not is_non_empty_str(component_name) or not is_number(component_value):
                        problems.append(f"{label}.hypotheses[{index}].components must map strings to numeric values")
                        break
            for list_key in ["contributors", "contradictions", "edgeKinds", "geometries"]:
                if not isinstance(hypothesis.get(list_key), list):
                    problems.append(f"{label}.hypotheses[{index}].{list_key} must be a list")

            score = hypothesis.get("score")
            if not isinstance(score, dict):
                problems.append(f"{label}.hypotheses[{index}].score must be an object")
            else:
                score_keys = set(score.keys())
                if score_keys != EXPECTED_SCORE_KEYS:
                    problems.append(f"{label}.hypotheses[{index}].score keys mismatch: {sorted(score_keys)}")
                append_problem(problems, is_number(score.get("rank_score")), f"{label}.hypotheses[{index}].score.rank_score must be numeric")
                append_problem(problems, score.get("severity") in SEVERITIES, f"{label}.hypotheses[{index}].score.severity invalid")
                append_problem(problems, score.get("confidence") in CONFIDENCES, f"{label}.hypotheses[{index}].score.confidence invalid")
                append_problem(problems, is_non_negative_int(score.get("geometry_count")), f"{label}.hypotheses[{index}].score.geometry_count must be a non-negative int")
                append_problem(problems, is_non_negative_int(score.get("evidence_count")), f"{label}.hypotheses[{index}].score.evidence_count must be a non-negative int")
                append_problem(problems, is_non_negative_int(score.get("independence_count")), f"{label}.hypotheses[{index}].score.independence_count must be a non-negative int")
                validate_string_list(score.get("calculation_notes"), f"{label}.hypotheses[{index}].score.calculation_notes", problems, non_empty=True)

            packet = hypothesis.get("investigation_packet")
            if not isinstance(packet, dict):
                problems.append(f"{label}.hypotheses[{index}].investigation_packet must be an object")
            else:
                packet_keys = set(packet.keys())
                if packet_keys != EXPECTED_INVESTIGATION_KEYS:
                    problems.append(f"{label}.hypotheses[{index}].investigation_packet keys mismatch: {sorted(packet_keys)}")
                for key in ["objective", "suspected_invariant"]:
                    append_problem(problems, is_non_empty_str(packet.get(key)), f"{label}.hypotheses[{index}].investigation_packet.{key} must be a non-empty string")
                validate_string_list(packet.get("first_questions"), f"{label}.hypotheses[{index}].investigation_packet.first_questions", problems, non_empty=True)
                validate_string_list(packet.get("forbidden_scope"), f"{label}.hypotheses[{index}].investigation_packet.forbidden_scope", problems, non_empty=True)
                validate_string_list(packet.get("recommended_verification"), f"{label}.hypotheses[{index}].investigation_packet.recommended_verification", problems, non_empty=True)
                anchors = packet.get("suggested_center_anchors")
                if not isinstance(anchors, list) or not anchors:
                    problems.append(f"{label}.hypotheses[{index}].investigation_packet.suggested_center_anchors must be a non-empty list")
                else:
                    for anchor_index, anchor in enumerate(anchors):
                        validate_anchor(anchor, f"{label}.hypotheses[{index}].investigation_packet.suggested_center_anchors[{anchor_index}]", problems)

    if isinstance(scan_obj.get("count"), int) and isinstance(hypotheses, list) and scan_obj["count"] != len(hypotheses):
        problems.append(f"{label}.count does not match hypothesis count: {scan_obj['count']} != {len(hypotheses)}")
    if isinstance(scan_obj.get("raw_signal_count"), int) and isinstance(signals, list) and scan_obj["raw_signal_count"] < len(signals):
        problems.append(f"{label}.raw_signal_count is less than signal count: {scan_obj['raw_signal_count']} < {len(signals)}")
    return problems


def validate_diff_report(diff_obj: object, label: str) -> list[str]:
    problems: list[str] = []
    if not isinstance(diff_obj, dict):
        return [f"{label} must be a JSON object"]
    actual_keys = set(diff_obj.keys())
    if actual_keys != EXPECTED_DIFF_KEYS:
        problems.append(f"{label} top-level keys mismatch: {sorted(actual_keys)}")
    for key in ["schema_version", "base_path", "head_path"]:
        append_problem(problems, is_non_empty_str(diff_obj.get(key)), f"{label}.{key} must be a non-empty string")
    for key in ["base_count", "head_count", "unchanged_count"]:
        append_problem(problems, is_non_negative_int(diff_obj.get(key)), f"{label}.{key} must be a non-negative int")
    for key in ["new_hypotheses", "resolved_hypotheses", "changed_hypotheses"]:
        if not isinstance(diff_obj.get(key), list):
            problems.append(f"{label}.{key} must be a list")
    return problems


def run_cmd(args: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def run_e2e() -> list[str]:
    problems: list[str] = []
    if not APP_ROOT.exists():
        return [f"app_root missing on disk: {APP_ROOT.as_posix()}"]

    build = run_cmd([NPM_BIN, "run", "build"], APP_ROOT, 300)
    if build.returncode != 0:
        problems.append("npm run build failed")
        problems.append((build.stdout + build.stderr)[-1200:])
        return problems

    help_proc = run_cmd([NODE_BIN, "dist/cli/main.js", "--help"], APP_ROOT, 120)
    if help_proc.returncode != 0:
        problems.append("center-geo --help failed")
        problems.append((help_proc.stdout + help_proc.stderr)[-1200:])
        return problems
    help_text = help_proc.stdout + help_proc.stderr
    for token in ["Commands:", "scan", "diff", "index"]:
        if token not in help_text:
            problems.append(f"--help missing expected token: {token}")

    outdir = APP_ROOT / ".hermes" / "skill-selftest-center-multigeometry"
    if outdir.exists():
        if outdir.name != "skill-selftest-center-multigeometry" or outdir.parent.name != ".hermes":
            problems.append(f"refusing to remove unexpected selftest output dir: {outdir}")
            return problems
        shutil.rmtree(outdir)

    scan = run_cmd(
        [NODE_BIN, "dist/cli/main.js", "scan", ".", "--format", "json", "--output-dir", str(outdir)],
        APP_ROOT,
        300,
    )
    if scan.returncode not in {0, 1}:
        problems.append(f"scan exit code unexpected: {scan.returncode}")
        problems.append((scan.stdout + scan.stderr)[-1200:])
        return problems

    try:
        scan_obj = json.loads(scan.stdout)
    except json.JSONDecodeError as exc:
        problems.append(f"scan stdout is not valid JSON: {exc}")
        problems.append(scan.stdout[:800])
        return problems

    problems.extend(validate_scan_report(scan_obj, "scan stdout JSON"))
    if "wrote reports to" not in scan.stderr:
        problems.append("scan stderr missing output-dir confirmation")

    if not outdir.exists():
        problems.append(f"scan output dir missing: {outdir.as_posix()}")
        return problems
    actual_reports = {p.name for p in outdir.iterdir() if p.is_file()}
    if actual_reports != EXPECTED_REPORT_FILES:
        problems.append(f"report files mismatch: {sorted(actual_reports)}")
        return problems

    report_json_obj = json.loads((outdir / "report.json").read_text(encoding="utf-8"))
    problems.extend(validate_scan_report(report_json_obj, "report.json"))

    report_md = (outdir / "report.md").read_text(encoding="utf-8")
    disclaimer = "These are structural risk hypotheses derived from graph evidence. They are not confirmed defects until reproduced or proven by a focused audit."
    if disclaimer not in report_md:
        problems.append("report.md missing structural-risk disclaimer")

    diff = run_cmd(
        [NODE_BIN, "dist/cli/main.js", "diff", str(outdir / "report.json"), str(outdir / "report.json")],
        APP_ROOT,
        120,
    )
    if diff.returncode != 0:
        problems.append(f"diff exit code unexpected: {diff.returncode}")
        problems.append((diff.stdout + diff.stderr)[-1200:])
        return problems

    try:
        diff_obj = json.loads(diff.stdout)
    except json.JSONDecodeError as exc:
        problems.append(f"diff stdout is not valid JSON: {exc}")
        problems.append(diff.stdout[:800])
        return problems

    problems.extend(validate_diff_report(diff_obj, "diff stdout JSON"))
    if diff_obj.get("new_hypotheses") != []:
        problems.append("diff self-compare produced unexpected new_hypotheses")
    if diff_obj.get("changed_hypotheses") != []:
        problems.append("diff self-compare produced unexpected changed_hypotheses")
    if "# decision:" not in diff.stderr:
        problems.append("diff stderr missing human decision line")

    return problems


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Validate the center-multigeometry skill bundle.")
    ap.add_argument("--portable", action="store_true", help="validate only the bundle contents; no local clone or build assumptions")
    ap.add_argument("--local", action="store_true", help="validate repo-local assumptions like spec docs and app_root")
    ap.add_argument("--selftest", action="store_true", help="run portable + local validation, then the real built-CLI end-to-end selftest")
    args = ap.parse_args(argv)

    explicit_mode = args.portable or args.local or args.selftest
    run_portable = args.portable or args.selftest or not explicit_mode
    run_local_mode = args.local or args.selftest
    run_selftest_mode = args.selftest

    mode_labels: list[str] = []
    if run_portable:
        mode_labels.append("portable")
    if run_local_mode:
        mode_labels.append("local")
    if run_selftest_mode:
        mode_labels.append("selftest")

    problems: list[str] = []
    if run_portable:
        problems.extend(validate_bundle())
    if run_local_mode and not problems:
        problems.extend(validate_local())
    if run_selftest_mode and not problems:
        problems.extend(run_e2e())

    mode_label = "+".join(mode_labels) if mode_labels else "portable"
    if problems:
        print(f"[FAIL] center-multigeometry {mode_label} validation")
        for item in problems:
            print(f"- {item}")
        return 1

    if run_selftest_mode:
        print("[OK] center-multigeometry selftest passed")
    elif run_local_mode and run_portable:
        print("center-multigeometry portable+local validation passed")
    elif run_local_mode:
        print("center-multigeometry local validation passed")
    else:
        print("center-multigeometry portable validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
