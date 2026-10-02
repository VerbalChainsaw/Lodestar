import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { COMMANDS } from "../src/cli-commands.mjs";
import { normalizeMutationRequest } from "../src/records.mjs";
import { validatePutInput } from "../src/validate.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("current release has one dated changelog entry and versioned installation guidance", async () => {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const entries = [...changelog.matchAll(/^## (3\.0\.0[^\r\n]*)/gmu)];
  assert.equal(entries.length, 1, "3.0.0 changes must share one release entry");
  assert.equal(entries[0][1], `${version} - 2026-10-02`);
  const notes = await readFile(path.join(root, `docs/releases/v${version}.md`), "utf8");
  assert.match(notes, /^Release date: 2026-10-02\.?$/mu);
  for (const file of ["README.md", "docs/installation.md", `docs/releases/v${version}.md`]) {
    const text = await readFile(path.join(root, file), "utf8");
    assert.ok(text.includes(`npm install --global lodestar-agent-context@${version}`), file);
    assert.ok(text.includes(`https://github.com/VerbalChainsaw/Lodestar/releases/tag/v${version}`), file);
    assert.match(text, /Node\.js 24\.15\.0/u);
    assert.match(text, /\.NET 10\s+Desktop\s+Runtime \(x64\)/u);
    assert.match(text, /PowerShell 7/u);
    assert.doesNotMatch(text, /local candidate|release candidate status|pending publication|after (?:the verified 3\.0\.0 release is|release) publi/iu, file);
  }
});

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  }))).flat();
}

async function shippedDocuments() {
  const direct = ["README.md", "CHANGELOG.md", "SECURITY.md", "docs/README.md", "docs/agent-bootstrap.json",
    "docs/limitations.md", "docs/schema.md", "docs/installation.md"].map((file) => path.join(root, file));
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const declaredMarkdown = packageJson.files.filter((file) => file.endsWith(".md") && !file.startsWith("!"))
    .map((file) => path.join(root, file));
  const managed = (await filesUnder(path.join(root, "managed-assets")))
    .filter((file) => /\.(?:md|json)$/u.test(file));
  const plugin = (await filesUnder(path.join(root, "codex-plugin")))
    .filter((file) => /\.(?:md|json)$/u.test(file));
  return [...new Set([...direct, ...declaredMarkdown, ...managed, ...plugin])];
}

function jsonFences(text) {
  return [...text.matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n```/gu)].map((match) => match[1]);
}

test("the shipped-example gate includes every explicitly packaged Markdown document", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const inspected = new Set(await shippedDocuments());
  for (const file of packageJson.files.filter((file) => file.endsWith(".md") && !file.startsWith("!"))) {
    assert.ok(inspected.has(path.join(root, file)), `Packaged documentation bypasses the example gate: ${file}`);
  }
});

test("every shipped JSON example parses and documented put inputs match the current contract", async () => {
  const documents = await shippedDocuments();
  const examples = [];
  for (const file of documents) {
    const text = await readFile(file, "utf8");
    for (const source of jsonFences(text)) examples.push({ file, value: JSON.parse(source) });
  }
  assert.ok(examples.length > 0, "at least one shipped JSON example is required");
  const mutations = examples.filter(({ value }) => value?.v === 5 && value?.write_basis && value?.input);
  assert.ok(mutations.length > 0, "at least one complete mutation example is required");
  let updateExamples = 0;
  for (const { value } of mutations) {
    const request = normalizeMutationRequest(value);
    if (request.input.mode === "update") {
      updateExamples += 1;
      assert.equal(typeof request.input.id, "string");
      assert.ok(request.input.set !== null && typeof request.input.set === "object"
        && !Array.isArray(request.input.set)
        && Object.getPrototypeOf(request.input.set) === Object.prototype,
        "update examples carry a plain-object set");
      assert.ok(Array.isArray(request.input.remove)
        && request.input.remove.every((key) => typeof key === "string"),
        "update examples carry an array remove of string keys");
      continue;
    }
    assert.equal(request.input.mode, "create");
    const record = request.input.record;
    validatePutInput({ id: record.id, type: record.kind, name: record.name, scope: record.scope,
      priority: record.priority ?? 0, content: { state: record.availability, value: record.data,
        _lodestar: { priority: record.priority ?? 0, revision: 1, semantics: record.semantics } },
      aliases: record.aliases, links: record.links, sources: record.sources });
  }
  assert.ok(updateExamples >= 1, "at least one shipped update example is required");
});

test("shipped command examples use current command families and versioned release artifacts", async () => {
  for (const file of await shippedDocuments()) {
    if (["CHANGELOG.md", "SECURITY.md"].includes(path.basename(file))) continue;
    const text = await readFile(file, "utf8");
    const commandExamples = [...text.matchAll(/`lodestar\s+([a-z][a-z-]*)/gu),
      ...text.matchAll(/^lodestar\s+([a-z][a-z-]*)/gmu)];
    for (const match of commandExamples) {
      assert.ok(Object.hasOwn(COMMANDS, match[1]), `${file} documents unknown command ${match[1]}`);
    }
    assert.doesNotMatch(text, /npm install --global lodestar-agent-context(?:@2\.0\.0)?(?:\s|$)/u,
      `${file} must identify a supported package version`);
  }
});

test("current package guidance includes the canonical FAQ, troubleshooting and maintainer guides", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const file of ["Q&A.md", "HEADACHES.md", "docs/README.md", "docs/publishing.md"]) {
    assert.ok(packageJson.files.includes(file), `Missing maintained package guide: ${file}`);
  }
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme, /\[FAQ\]\(Q&A\.md\)/u);
  const index = await readFile(path.join(root, "docs/README.md"), "utf8");
  assert.match(index, /\[publishing guide\]\(publishing\.md\)/u);
  for (const file of ["Q&A.md", "HEADACHES.md", "NEEDS.md"]) {
    const text = await readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /lodestar-agent-context@2\.1\.2|(?:current release|public design boundary) for Lodestar 2\.1\.2/u);
  }
  const toolchain = await readFile(path.join(root, "managed-assets/skills/lodestar/references/toolchain.md"), "utf8");
  const installation = toolchain.slice(0, toolchain.indexOf("```bash"));
  assert.match(installation, /after.{0,80}publi/isu, 'npm example needs its publication condition before the command');
  assert.match(installation, /candidate.*tarball/isu, 'current local evaluation needs an exact candidate path');
});

test("Windows application manifest identity agrees with the release assembly version", async () => {
  const project = await readFile(path.join(root, "desktop/Lodestar.Loader/Lodestar.Loader.csproj"), "utf8");
  const manifest = await readFile(path.join(root, "desktop/Lodestar.Loader/app.manifest"), "utf8");
  const version = /<AssemblyVersion>([^<]+)<\/AssemblyVersion>/u.exec(project)?.[1];
  assert.ok(version);
  assert.equal(/<assemblyIdentity version="([^"]+)"/u.exec(manifest)?.[1], version);
  assert.match(manifest, /manifestVersion="1\.0"/u);
});
