import assert from "node:assert/strict";
import test from "node:test";

import { readCurrentGeneration } from "../lib/generation.mjs";
import { updateStore } from "../tools/tool-store.mjs";
import { withStoreFixture } from "../test-support/store-fixture.mjs";

test("an audit-write failure restores the previously active generation", async () => {
  await withStoreFixture(async () => ({
    catalog: { v: 1, projects: [] },
    schema: { v: 1, record_kinds: ["rule"] },
    globalRecords: [{
      v: 1,
      id: "g:bootstrap",
      kind: "rule",
      priority: 1000,
      scope: ["global"],
      links: [],
    }],
    projectRecords: {},
  }), async ({ home }) => {
    const before = await readCurrentGeneration(home);
    await assert.rejects(
      updateStore({
        home,
        op: "test-audit-failure",
        transform(source) {
          source.globalRecords[0].summary = "must not become active";
          return {};
        },
        appendEvent: async () => {
          throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
        },
      }),
      (error) =>
        error.code === "store-audit-write-failed"
        && error.cause?.code === "EIO"
        && error.detail.restored_generation === before.id,
    );
    assert.equal((await readCurrentGeneration(home)).id, before.id);
  });
});
