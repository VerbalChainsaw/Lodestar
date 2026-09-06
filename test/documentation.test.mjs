import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { COMMANDS } from "../src/cli-commands.mjs";
import { normalizeMutationRequest } from "../src/records.mjs";
import { validatePutInput } from "../src/validate.mjs";

const root = path.resolve(import.meta.dirname, "..");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  }))).flat();
}

async function shippedDocuments() {
  const direct = ["README.md", "CHANGELOG.md", "SECURITY.md", "docs/README.md", "docs/agent-bootstrap.json",
    "docs/limitations.md", "docs/schema.md", "docs/releases/v2.0.0.md"].map((file) => path.join(root, file));
  const managed = (await filesUnder(path.join(root, "managed-assets")))
    .filter((file) => /\.(?:md|json)$/u.test(file));
  const plugin = (await filesUnder(path.join(root, "codex-plugin")))
    .filter((file) => /\.(?:md|json)$/u.test(file));
  return [...direct, ...managed, ...plugin];
}

function jsonFences(text) {
  return [...text.matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n```/gu)].map((match) => match[1]);
}

test("every shipped JSON example parses and documented put input matches the current contract", async () => {
  const documents = await shippedDocuments();
  const examples = [];
  for (const file of documents) {
    const text = await readFile(file, "utf8");
    for (const source of jsonFences(text)) examples.push({ file, value: JSON.parse(source) });
  }
  assert.ok(examples.length > 0, "at least one shipped JSON example is required");
  const mutations = examples.filter(({ value }) => value?.v === 5 && value?.write_basis && value?.input);
  assert.ok(mutations.length > 0, "at least one complete mutation example is required");
  for (const { value } of mutations) {
    const request = normalizeMutationRequest(value);
    assert.equal(request.input.mode, "create");
    const record = request.input.record;
    validatePutInput({ id: record.id, type: record.kind, name: record.name, scope: record.scope,
      priority: record.priority ?? 0, content: { state: record.availability, value: record.data,
        _lodestar: { priority: record.priority ?? 0, revision: 1, semantics: record.semantics } },
      aliases: record.aliases, links: record.links, sources: record.sources });
  }
});

test("shipped command examples use current command families and the local release artifact", async () => {
  for (const file of await shippedDocuments()) {
    if (["CHANGELOG.md", "SECURITY.md"].includes(path.basename(file))) continue;
    const text = await readFile(file, "utf8");
    const commandExamples = [...text.matchAll(/`lodestar\s+([a-z][a-z-]*)/gu),
      ...text.matchAll(/^lodestar\s+([a-z][a-z-]*)/gmu)];
    for (const match of commandExamples) {
      assert.ok(Object.hasOwn(COMMANDS, match[1]), `${file} documents unknown command ${match[1]}`);
    }
    assert.doesNotMatch(text, /npm install --global lodestar-agent-context(?:@2\.0\.0)?(?:\s|$)/u,
      `${file} points at an unpublished registry artifact`);
  }
});
