import { createHash } from "node:crypto";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASSETS = path.join(ROOT, "managed-assets");
const SKILLS = path.join(ASSETS, "skills");
const MANIFEST = path.join(ASSETS, "manifest.json");
const PAYLOAD = path.join(ROOT, "src", "skills-payload.json");
const DOCUMENTED_BOOTSTRAP = path.join(ROOT, "docs", "agent-bootstrap.json");
const TRANSFORMATIONS = path.join(ASSETS, "historical-source-transformations.json");
const PLUGIN_SKILLS = path.join(ROOT, "codex-plugin", "skills");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const present = async (file) => access(file).then(() => true, () => false);

// The lock asserts content parity, not byte parity, and it has to survive a checkout.
// Managed targets are tracked and .gitattributes normalizes them to LF, while the
// historical sources sit in an untracked backup that keeps its original CRLF. Hashing
// raw bytes therefore passes on the machine that wrote them and fails on every fresh
// clone, which is what CI and a release build both are.
const TEXT = /\.(?:md|json|mjs|ya?ml|txt|sh)$/u;
const canonicalBytes = (file, bytes) => (TEXT.test(file)
  ? Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8")
  : bytes);
const hashFile = (file, bytes) => sha256(canonicalBytes(file, bytes));

async function collect(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(root, absolute));
    else if (entry.isFile()) {
      // Normalized for the same reason as the parity hashes: the payload embeds this
      // content verbatim, so raw CRLF would make the generated payload differ between
      // the authoring machine and any fresh checkout.
      files.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        content: (await readFile(absolute, "utf8")).replaceAll("\r\n", "\n"),
      });
    } else throw new Error(`Managed assets may contain only directories and files: ${absolute}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function verifyTransformations() {
  const manifest = JSON.parse(await readFile(TRANSFORMATIONS, "utf8"));
  if (manifest?.schema !== 1 || !Array.isArray(manifest.entries)
      || manifest.entries.length === 0 || new Set(manifest.entries.map(({ path: file }) => file)).size
        !== manifest.entries.length) {
    throw new Error("The historical source transformation manifest is malformed");
  }
  for (const entry of manifest.entries) {
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)
        || !["copy", "rewrite", "fold", "omit"].includes(entry.action)
        || !Array.isArray(entry.targets) || typeof entry.reason !== "string") {
      throw new Error(`Invalid source transformation entry: ${entry.path}`);
    }
    // Two classes may be omitted, and both must be declared rather than simply absent,
    // so a source can never leave the parity lock silently. Private sources stay
    // inventoried and hash-checked below; they are only kept out of the published
    // package, because project-specific instructions are user content and shipping
    // them would publish private repository names and local filesystem layout.
    if (entry.action === "omit") {
      const generated = entry.path.includes("/__pycache__/");
      if ((!generated && entry.private !== true) || entry.targets.length !== 0) {
        throw new Error(
          `Only generated cache files or declared private sources may be omitted: ${entry.path}`,
        );
      }
      continue;
    }
    if (entry.targets.length === 0) throw new Error(`Unmapped historical source: ${entry.path}`);
    for (const target of entry.targets) {
      const bytes = await readFile(path.join(ROOT, target.path));
      if (hashFile(target.path, bytes) !== target.sha256) {
        throw new Error(`Transformed managed target does not match its declared hash: ${target.path}`);
      }
      if (entry.action === "copy" && target.sha256 !== entry.sha256) {
        throw new Error(`Byte-for-byte source copy drifted: ${entry.path}`);
      }
    }
  }

  const historical = path.resolve(ROOT, manifest.source_root_hint);
  if (await present(historical)) {
    const files = ["README.md", "03-toolchain.md"];
    for (const directory of ["00-doctrine", "01-skills", "02-agents-md-library"]) {
      files.push(...(await collect(path.join(historical, directory)))
        .map(({ path: file }) => `${directory}/${file}`));
    }
    files.sort((left, right) => left.localeCompare(right));
    const declared = manifest.entries.map(({ path: file }) => file)
      .sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(files) !== JSON.stringify(declared)) {
      throw new Error("The allowlisted historical source inventory changed");
    }
    for (const entry of manifest.entries) {
      if (hashFile(entry.path, await readFile(path.join(historical, entry.path))) !== entry.sha256) {
        throw new Error(`The allowlisted historical source changed: ${entry.path}`);
      }
    }
  }
}

async function build() {
  await verifyTransformations();
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  if (manifest?.schema !== 2 || !Array.isArray(manifest.skills)
      || typeof manifest.bootstrap !== "string" || typeof manifest.governance !== "string") {
    throw new Error("managed-assets/manifest.json must use schema 2 and list all sources");
  }
  const available = (await readdir(SKILLS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (JSON.stringify([...manifest.skills].sort()) !== JSON.stringify(available)) {
    throw new Error("Managed skill directories must exactly match the manifest");
  }
  const skills = [];
  for (const name of manifest.skills) {
    const directory = path.join(SKILLS, name);
    if (!(await stat(path.join(directory, "SKILL.md"))).isFile()) {
      throw new Error(`Managed skill ${name} must contain SKILL.md`);
    }
    skills.push({ name, files: await collect(directory) });
  }
  const pluginSkillNames = (await readdir(PLUGIN_SKILLS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (JSON.stringify(pluginSkillNames) !== JSON.stringify(["lodestar"])) {
    throw new Error("The Lodestar plugin must bundle only the Lodestar umbrella skill");
  }
  const managedLodestar = skills.find(({ name }) => name === "lodestar")?.files;
  const pluginLodestar = await collect(path.join(PLUGIN_SKILLS, "lodestar"));
  if (JSON.stringify(managedLodestar) !== JSON.stringify(pluginLodestar)) {
    throw new Error("The bundled Lodestar plugin skill does not match the managed source");
  }
  const bootstrap = JSON.parse(await readFile(path.join(ASSETS, manifest.bootstrap), "utf8"));
  const governance = JSON.parse(await readFile(path.join(ASSETS, manifest.governance), "utf8"));
  if (bootstrap?.version !== 2 || typeof bootstrap.text !== "string"
      || !Array.isArray(bootstrap.instructions) || governance?.data?.required !== true) {
    throw new Error("Managed bootstrap and governance sources are malformed");
  }
  return {
    payload: `${JSON.stringify({ schema: 2, bootstrap, governance, skills })}\n`,
    bootstrap: `${JSON.stringify(bootstrap, null, 2)}\n`,
  };
}

const mode = process.argv[2] ?? "--write";
const generated = await build();
if (mode === "--check") {
  if (generated.payload !== await readFile(PAYLOAD, "utf8")
      || generated.bootstrap !== await readFile(DOCUMENTED_BOOTSTRAP, "utf8")) {
    throw new Error("src/skills-payload.json is stale; run npm run assets:build");
  }
} else if (mode === "--write") {
  await writeFile(PAYLOAD, generated.payload, "utf8");
  await writeFile(DOCUMENTED_BOOTSTRAP, generated.bootstrap, "utf8");
}
else throw new Error("Usage: build-managed-assets.mjs [--write|--check]");
