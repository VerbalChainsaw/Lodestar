import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASSETS = path.join(ROOT, "managed-assets");
const SKILLS = path.join(ASSETS, "skills");
const MANIFEST = path.join(ASSETS, "manifest.json");
const DOCUMENTED_BOOTSTRAP = path.join(ROOT, "docs", "agent-bootstrap.json");
const PLUGIN_LODESTAR = path.join(ROOT, "codex-plugin", "skills", "lodestar");
const BOOTSTRAP_STUB = path.join(SKILLS, "lodestar", "assets", "templates", "_stub-pattern.AGENTS.md");
const CONTRACT = 5;
const DISTRIBUTION_OWNER = "npm:lodestar-agent-context";
const SOURCE_IDS = Object.freeze({
  "director-protocol": "golden-rules:director-protocol",
  codeplan: "golden-rules:codeplan",
  "center-multigeometry": "golden-rules:center-multigeometry",
  "center-audit": "golden-rules:center-audit",
  "ladder-audit": "golden-rules:ladder-audit",
  lodestar: "lodestar-repository:lodestar",
  adderall: "lodestar-repository:adderall",
});
const GOLDEN_SKILLS = Object.keys(SOURCE_IDS).filter((name) => SOURCE_IDS[name].startsWith("golden-rules:"));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function collect(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(root, absolute));
    else if (entry.isFile()) {
      const content = await readFile(absolute);
      files.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        bytes: content.length,
        sha256: sha256(content),
        content,
      });
    } else throw new Error(`Managed assets may contain only files and directories: ${absolute}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function payloadIdentity(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(file.content.length));
    hash.update(file.path).update(Buffer.of(0)).update(size).update(file.content);
  }
  return hash.digest("hex");
}

async function inventory() {
  const names = (await readdir(SKILLS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(SOURCE_IDS).sort())) {
    throw new Error("Managed skill directories do not match the complete contract-5 source set");
  }
  const skills = [];
  for (const name of names) {
    const root = path.join(SKILLS, name);
    if (!(await stat(path.join(root, "SKILL.md"))).isFile()) {
      throw new Error(`Maintained skill ${name} is missing SKILL.md`);
    }
    const files = await collect(root);
    skills.push({
      name,
      source_id: SOURCE_IDS[name],
      source_entrypoint: `skills/${name}/SKILL.md`,
      source_identity: { algorithm: "sha256", value: payloadIdentity(files) },
      payload_root: `skills/${name}`,
      files: files.map(({ path: file, bytes, sha256: digest }) => ({
        path: file, bytes, sha256: digest,
      })),
      distribution_owner: DISTRIBUTION_OWNER,
    });
  }
  return { contract: CONTRACT, bootstrap: "bootstrap.json", skills };
}

async function validateBootstrap() {
  const bootstrap = JSON.parse(await readFile(path.join(ASSETS, "bootstrap.json"), "utf8"));
  if (bootstrap?.version !== CONTRACT || typeof bootstrap.text !== "string"
      || !Array.isArray(bootstrap.instructions)) {
    throw new Error("Canonical bootstrap must be a complete contract-5 declaration");
  }
  return bootstrap;
}

async function mirrorTree(sourceRoot, destinationRoot, write) {
  const source = await collect(sourceRoot);
  let target = [];
  try { target = await collect(destinationRoot); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (write) {
    await rm(destinationRoot, { recursive: true, force: true });
    for (const file of source) {
      const destination = path.join(destinationRoot, ...file.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
    return;
  }
  if (JSON.stringify(source.map(({ path: file }) => file))
      !== JSON.stringify(target.map(({ path: file }) => file))) {
    throw new Error("Codex plugin Lodestar mirror membership differs from its maintained source");
  }
  for (let index = 0; index < source.length; index += 1) {
    if (source[index].bytes !== target[index].bytes
        || source[index].sha256 !== target[index].sha256) {
      throw new Error(`Codex plugin Lodestar mirror drifted: ${source[index].path}`);
    }
  }
}

const mode = process.argv[2] ?? "--check";
const sourceIndex = process.argv.indexOf("--source-root");
const goldenRoot = sourceIndex < 0 ? null : path.resolve(process.argv[sourceIndex + 1] ?? "");
if (!["--check", "--write"].includes(mode) || (sourceIndex >= 0 && !process.argv[sourceIndex + 1])) {
  throw new Error("Usage: build-managed-assets.mjs [--write|--check] [--source-root <golden-rules-root>]");
}
if (mode === "--write" && !goldenRoot) {
  throw new Error("assets:build requires --source-root so generated Golden skill copies have an explicit owner");
}
if (goldenRoot) {
  for (const name of GOLDEN_SKILLS) {
    const source = path.join(goldenRoot, "skills", name);
    const destination = path.join(SKILLS, name);
    await mirrorTree(source, destination, mode === "--write");
  }
}
const bootstrap = await validateBootstrap();
if (mode === "--write") await writeFile(BOOTSTRAP_STUB, bootstrap.text, "utf8");
else if (await readFile(BOOTSTRAP_STUB, "utf8") !== bootstrap.text) {
  throw new Error("Canonical repository bootstrap differs from bootstrap.json");
}
const manifestText = `${JSON.stringify(await inventory(), null, 2)}\n`;
const bootstrapText = `${JSON.stringify(bootstrap, null, 2)}\n`;
if (mode === "--write") {
  await mirrorTree(path.join(SKILLS, "lodestar"), PLUGIN_LODESTAR, true);
  await writeFile(MANIFEST, manifestText, "utf8");
  await writeFile(DOCUMENTED_BOOTSTRAP, bootstrapText, "utf8");
} else {
  await mirrorTree(path.join(SKILLS, "lodestar"), PLUGIN_LODESTAR, false);
  if (await readFile(MANIFEST, "utf8") !== manifestText) {
    throw new Error("Managed asset byte manifest is stale; run npm run assets:build");
  }
  if (await readFile(DOCUMENTED_BOOTSTRAP, "utf8") !== bootstrapText) {
    throw new Error("Generated bootstrap documentation is stale; run npm run assets:build");
  }
}
