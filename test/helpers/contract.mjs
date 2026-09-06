import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { runCli } from "../../src/cli.mjs";
import { openReadDatabase } from "../../src/database.mjs";
import { normalizeMutationRequest, writeBasis } from "../../src/records.mjs";
import { CONTRACT_VERSION } from "../../src/schema.mjs";

export async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-current-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = path.join(root, "lodestar.db");
  let sequence = 0;
  async function cli(args, body = null) {
    let stdout = "", stderr = "";
    const code = await runCli(["--db", database, ...args], {
      stdin: Readable.from(body === null ? [] : [JSON.stringify(body)]),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });
    return { code, value: JSON.parse(stdout || stderr) };
  }
  assert.equal((await cli(["init"])).code, 0);
  async function request(input, targets, projectScope = null, actor = null) {
    const db = await openReadDatabase(database);
    try { return normalizeMutationRequest({ v: CONTRACT_VERSION, request_id: `test-${++sequence}`,
      write_basis: writeBasis(db, { projectScope, targets, checkout: root }), input }, { actor }); }
    finally { db.close(); }
  }
  async function create(id, kind, data, scope = "global", semantics = undefined) {
    const body = await request({ mode: "create", record: { id, kind, name: id, scope,
      availability: "known", data, aliases: [], links: [], sources: [],
      ...(semantics ? { semantics: { basis: "asserted", applicability: { project: scope, checkout: null }, ...semantics } } : {}) } }, [{ kind: "record", id }], scope === "global" ? null : scope);
    const result = await cli(["put"], body);
    assert.equal(result.code, 0, JSON.stringify(result.value));
    return result;
  }
  return { root, database, cli, request, create };
}

