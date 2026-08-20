import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASSETS = path.join(ROOT, "managed-assets");
const SKILLS = path.join(ASSETS, "skills");
const MANIFEST = path.join(ASSETS, "manifest.json");
const DOCUMENTED_BOOTSTRAP = path.join(ROOT, "docs", "agent-bootstrap.json");
const DOCUMENTED_GOVERNANCE = path.join(ROOT, "docs", "GOLDEN-RULES.md");
const PLUGIN_LODESTAR = path.join(ROOT, "codex-plugin", "skills", "lodestar");
const BOOTSTRAP_STUBS = [
  path.join(SKILLS, "lodestar", "assets", "templates", "_stub-pattern.AGENTS.md"),
  path.join(PLUGIN_LODESTAR, "assets", "templates", "_stub-pattern.AGENTS.md"),
];

async function collect(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(root, absolute));
    else if (entry.isFile()) files.push({
      path: path.relative(root, absolute).split(path.sep).join("/"),
      content: (await readFile(absolute, "utf8")).replaceAll("\r\n", "\n"),
    });
    else throw new Error(`Canonical assets may contain only files and directories: ${absolute}`);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function canonical() {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  if (manifest?.schema !== 2 || !Array.isArray(manifest.skills)
      || typeof manifest.bootstrap !== "string" || typeof manifest.governance !== "string")
    throw new Error("managed-assets/manifest.json is malformed");
  const dirs = (await readdir(SKILLS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (JSON.stringify(dirs) !== JSON.stringify([...manifest.skills].sort()))
    throw new Error("Canonical managed skill directories do not match the manifest");
  for (const name of manifest.skills) {
    if (!(await stat(path.join(SKILLS, name, "SKILL.md"))).isFile())
      throw new Error(`Canonical managed skill ${name} is missing SKILL.md`);
  }
  const bootstrap = JSON.parse(await readFile(path.join(ASSETS, manifest.bootstrap), "utf8"));
  const governance = JSON.parse(await readFile(path.join(ASSETS, manifest.governance), "utf8"));
  if (!Number.isSafeInteger(bootstrap?.version) || typeof bootstrap.text !== "string"
      || !Array.isArray(bootstrap.instructions)) throw new Error("Canonical bootstrap is malformed");
  if (governance?.id !== "g:lodestar:required-governance"
      || governance?.data?.required !== true || typeof governance?.data?.text !== "string")
    throw new Error("Canonical governance is malformed");
  return { manifest, bootstrap, governance };
}

function governanceView(governance) {
  return `# Director Golden Operating Rules\n\n> Human-readable view of the exact canonical rule body in `
    + "`managed-assets/governance.json`. This file is not runtime authority.\n\n"
    + governance.data.text.replaceAll("\r\n", "\n").trimEnd() + "\n";
}

async function mirrorLodestar(write) {
  const source = await collect(path.join(SKILLS, "lodestar"));
  const target = await collect(PLUGIN_LODESTAR);
  const sourcePaths = source.map(({ path: file }) => file);
  const targetPaths = target.map(({ path: file }) => file);
  if (JSON.stringify(sourcePaths) !== JSON.stringify(targetPaths))
    throw new Error("Codex plugin Lodestar mirror file set differs from canonical source");
  if (write) {
    for (const file of source) {
      const destination = path.join(PLUGIN_LODESTAR, ...file.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content, "utf8");
    }
  } else {
    for (let index = 0; index < source.length; index += 1) {
      if (source[index].content !== target[index].content)
        throw new Error(`Codex plugin Lodestar mirror drifted: ${source[index].path}`);
    }
  }
}

async function mirrorBootstrapStub(write, text) {
  for (const stub of BOOTSTRAP_STUBS) {
    if (write) await writeFile(stub, text, "utf8");
    else if (await readFile(stub, "utf8") !== text)
      throw new Error(`Canonical bootstrap stub drifted: ${stub}`);
  }
}

const mode = process.argv[2] ?? "--check";
if (!["--check", "--write"].includes(mode))
  throw new Error("Usage: build-managed-assets.mjs [--write|--check]");
const { bootstrap, governance } = await canonical();
const bootstrapView = `${JSON.stringify(bootstrap, null, 2)}\n`;
const governanceText = governanceView(governance);
if (mode === "--write") {
  await mirrorLodestar(true);
  await mirrorBootstrapStub(true, bootstrap.text);
  await writeFile(DOCUMENTED_BOOTSTRAP, bootstrapView, "utf8");
  await writeFile(DOCUMENTED_GOVERNANCE, governanceText, "utf8");
} else {
  await mirrorLodestar(false);
  await mirrorBootstrapStub(false, bootstrap.text);
  if (bootstrapView !== await readFile(DOCUMENTED_BOOTSTRAP, "utf8")
      || governanceText !== await readFile(DOCUMENTED_GOVERNANCE, "utf8"))
    throw new Error("Generated documentation views are stale; run npm run assets:build");
}
