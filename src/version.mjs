import { readFileSync } from "node:fs";

export const LODESTAR_VERSION = JSON.parse(readFileSync(
  new URL("../package.json", import.meta.url), "utf8",
)).version;
