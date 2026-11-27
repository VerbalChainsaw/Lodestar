import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import test from "node:test";

import { dispatch } from "../src/agent-state.mjs";
import { openReadDatabase } from "../src/database.mjs";
import { directInterfaceSelection } from "../src/interface-config.mjs";
import { prepareCliJournal, storeCliResponse, retireCliJournal } from "../src/recovery-journal.mjs";
import { fixture } from "./helpers/contract.mjs";

async function overlappingContexts(t, replacementError = null) {
  const f = await fixture(t);
  const body = await f.request({ mode: "create", record: {
    id: "fact:context-sharing", kind: "fact", name: "Context sharing", scope: "global",
    data: { value: "once" }, aliases: [], links: [], sources: [],
  } }, [{ kind: "record", id: "fact:context-sharing" }]);
  const selection = await directInterfaceSelection(f.database);
  const owner = new AsyncLocalStorage(), timers = [];
  const gate = name => {
    let resolve;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      timers.push(setTimeout(() => no(new Error(`Context-sharing gate timed out: ${name}`)), 5000));
    });
    return { promise, resolve };
  };
  const prescanned = gate("prescan"), published = gate("publication"), opened = gate("peer open"), mayRead = gate("replacement");
  const original = { mkdir: fs.promises.mkdir, rename: fs.promises.rename, open: fs.promises.open };
  let prescans = 0, publications = 0, firstFolder, heldHandle, replacementAttempts = 0;
  const replacementSources = new Set(), replacementErrors = [];
  fs.promises.mkdir = async function (file, ...args) {
    if (String(file).endsWith(".preparing")) {
      if (++prescans === 2) prescanned.resolve();
      await prescanned.promise;
    }
    return original.mkdir.call(this, file, ...args);
  };
  fs.promises.rename = async function (from, to) {
    if (String(from).endsWith(".preparing")) {
      if (owner.getStore() === "first") firstFolder = to;
      const result = await original.rename.call(this, from, to);
      if (++publications === 2) published.resolve();
      await published.promise;
      return result;
    }
    if (owner.getStore() === "first" && path.basename(to) === "context.json" && path.dirname(to) === firstFolder) {
      await opened.promise;
      replacementAttempts += 1;
      replacementSources.add(from);
      try {
        if (replacementError) throw Object.assign(new Error("Persistent replacement refusal"), { code: replacementError });
        return await original.rename.call(this, from, to);
      } catch (error) {
        replacementErrors.push(error.code);
        throw error;
      } finally { mayRead.resolve(); }
    }
    return original.rename.call(this, from, to);
  };
  fs.promises.open = async function (file, ...args) {
    const handle = await original.open.call(this, file, ...args);
    if (!heldHandle && owner.getStore() === "second" && path.basename(file) === "context.json"
      && path.dirname(file) === firstFolder) {
      heldHandle = handle;
      opened.resolve();
      try { await mayRead.promise; }
      catch (error) { await handle.close(); throw error; }
    }
    return handle;
  };
  syncBuiltinESMExports();
  const parsed = [{ options: {}, positionals: [] }, { options: {}, positionals: [] }];
  let outcomes;
  try {
    outcomes = await Promise.allSettled(parsed.map((input, index) => owner.run(index ? "second" : "first",
      () => prepareCliJournal(selection, "put", input, ["put"], { stdin: Readable.from([JSON.stringify(body)]) }))));
  } finally {
    Object.assign(fs.promises, original); syncBuiltinESMExports();
    mayRead.resolve();
    for (const timer of timers) clearTimeout(timer);
  }
  assert.ok(heldHandle, "The peer must hold the actual published context handle");
  assert.equal(heldHandle.fd, -1, "The peer releases its handle after the first replacement attempt");
  return { f, body, parsed, outcomes, replacementAttempts, replacementSources, replacementErrors, firstFolder };
}

test("Windows context replacement survives an actual concurrent peer read and commits once", {
  skip: process.platform !== "win32",
}, async t => {
  const state = await overlappingContexts(t);
  assert.equal(state.replacementErrors[0], "EPERM", "Reproduce the native Windows sharing refusal, without injecting it");
  assert.deepEqual(state.outcomes.map(outcome => outcome.status), ["fulfilled", "fulfilled"],
    JSON.stringify(state.outcomes.map(outcome => ({ status: outcome.status, code: outcome.reason?.code,
      cause: outcome.reason?.cause?.code }))));
  assert.ok(state.replacementAttempts > 1);
  assert.equal(state.replacementSources.size, 1, "Retry the same saved temporary file");
  const accepted = [];
  for (let index = 0; index < state.outcomes.length; index += 1) {
    const journal = state.outcomes[index].value;
    assert.equal(await fs.promises.readFile(path.join(journal.folder, "request.json"), "utf8"), JSON.stringify(state.body));
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(journal.folder, "context.json"))).prior_outcome_unknown, true);
    const result = await dispatch("put", state.parsed[index], state.f.database, {});
    const envelope = { v: 5, ok: true, operation: "put", ...result };
    await storeCliResponse(journal, envelope);
    assert.equal(await retireCliJournal(journal, envelope), true);
    accepted.push(result);
  }
  assert.deepEqual(accepted.map(result => result.request.replayed), [false, true]);
  assert.equal(accepted[0].receipt_id, accepted[1].receipt_id);
  const db = await openReadDatabase(state.f.database);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE type='mutation-receipt'").get().n, 1);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='database_revision'").get().value, "1");
  } finally { db.close(); }
});

for (const code of ["EPERM", "EACCES"]) test(`persistent context ${code} is reported without dispatch or retry expansion`, {
  skip: process.platform !== "win32",
}, async t => {
  const state = await overlappingContexts(t, code);
  const outcome = state.outcomes[0];
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason.code, "recovery_journal_failed");
  assert.equal(outcome.reason.cause.code, code);
  assert.equal(outcome.reason.identifiers.committed, false);
  assert.equal(state.replacementAttempts, code === "EPERM" ? 51 : 1);
  assert.equal(state.replacementSources.size, 1);
  assert.equal(await fs.promises.readFile(path.join(state.firstFolder, "request.json"), "utf8"), JSON.stringify(state.body));
  assert.equal(JSON.parse(await fs.promises.readFile(path.join(state.firstFolder, "context.json"))).prior_outcome_unknown, false);
  const db = await openReadDatabase(state.f.database);
  try { assert.equal(db.prepare("SELECT COUNT(*) n FROM records").get().n, 0); }
  finally { db.close(); }
});
