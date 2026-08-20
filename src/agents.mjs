import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BOOTSTRAP_TEXT } from "./bootstrap.mjs";
import { lodestarError, wrapError } from "./errors.mjs";
import { translateWindowsDialectPath } from "./paths.mjs";
import { pathExists } from "./windows-install.mjs";

export const REPOSITORY_AGENTS_MARKER = "<!-- lodestar:managed-repository-bootstrap v1 -->";
const FULL_TEMPLATE = fileURLToPath(new URL(
  "../managed-assets/skills/lodestar/assets/templates/AGENTS.template.md",
  import.meta.url,
));

export const repositoryAgentsText = () => `${REPOSITORY_AGENTS_MARKER}\n${BOOTSTRAP_TEXT}`;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function resolveAgentsRoot(cwd = process.cwd(), spawn = spawnSync) {
  const translated = translateWindowsDialectPath(String(cwd), {
    includeMsys: process.platform === "win32",
  });
  const candidate = path.resolve(translated);
  const result = spawn("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const root = String(result?.stdout ?? "").trim();
  return root ? path.resolve(root) : candidate;
}

async function classify(destination) {
  if (!await pathExists(destination)) {
    return { state: "missing", text: null, sha256: null };
  }
  const text = await readFile(destination, "utf8");
  const expected = repositoryAgentsText();
  if (text === expected) return { state: "verified", text, sha256: digest(text) };
  if (text === BOOTSTRAP_TEXT) return { state: "legacy-managed", text, sha256: digest(text) };
  if (text.startsWith(`${REPOSITORY_AGENTS_MARKER}\n`)) {
    return { state: "stale", text, sha256: digest(text) };
  }
  return { state: "custom", text, sha256: digest(text) };
}

function assertAction(action) {
  if (["apply", "remove"].includes(action)) {
    throw lodestarError(
      "repository_agents_read_only",
      "Lodestar no longer writes, replaces, upgrades, or removes AGENTS.md files.",
      {
        identifiers: { operation: action },
        action: "Manage AGENTS.md outside Lodestar. Use `lodestar agents status`, `verify`, or `template` for read-only inspection.",
      },
    );
  }
  if (!["status", "verify", "template"].includes(action)) {
    throw lodestarError(
      "unknown_operation",
      "The agents operation must be status, verify, or template.",
      { identifiers: { operation: action } },
    );
  }
}

export async function manageAgents(action = "status", {
  cwd = process.cwd(),
  mode = "stub",
  spawn = spawnSync,
} = {}) {
  assertAction(action);
  if (!["stub", "full"].includes(mode)) {
    throw lodestarError("invalid_input", "Agent template mode must be stub or full.", {
      identifiers: { mode },
    });
  }
  if (action !== "template" && mode !== "stub") {
    throw lodestarError("invalid_input", "--mode applies only to `lodestar agents template`.", {
      identifiers: { operation: action, mode },
    });
  }
  const root = resolveAgentsRoot(cwd, spawn);
  const destination = path.join(root, "AGENTS.md");
  try {
    if (action === "template") {
      const text = mode === "stub"
        ? repositoryAgentsText()
        : await readFile(FULL_TEMPLATE, "utf8");
      return {
        action,
        readOnly: true,
        mode,
        projectRoot: root,
        path: destination,
        text,
      };
    }
    const original = await classify(destination);
    return {
      action,
      readOnly: true,
      projectRoot: root,
      path: destination,
      state: original.state,
      managed: ["verified", "legacy-managed", "stale"].includes(original.state),
      verified: original.state === "verified",
      sha256: original.sha256,
    };
  } catch (error) {
    throw wrapError(
      error,
      "repository_agents_read_failed",
      "Lodestar could not inspect the repository AGENTS.md file.",
      { identifiers: { operation: action, path: destination } },
    );
  }
}
