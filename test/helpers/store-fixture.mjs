import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildGeneration,
  promoteGeneration,
} from "../../lib/generation.mjs";
import { buildIndexes } from "../../lib/indexes.mjs";

export async function withStoreFixture(sourceOrBuilder, run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "lodestar-store-"));
  try {
    await mkdir(path.join(home, "generations"));
    const source = typeof sourceOrBuilder === "function"
      ? await sourceOrBuilder(home)
      : sourceOrBuilder;
    const generation = await buildGeneration({
      home,
      source,
      indexBuilder: (id) => buildIndexes({
        generation: id,
        catalog: source.catalog,
        globalRecords: source.globalRecords,
        projectRecords: source.projectRecords,
        probeLocator: source.probeLocator,
      }),
    });
    await promoteGeneration({ home, generation });
    await run({ home, generation, source });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
