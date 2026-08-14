import { readFileSync } from "node:fs";
const managed = JSON.parse(readFileSync(new URL("./skills-payload.json", import.meta.url), "utf8"));
if (managed?.schema !== 2 || !managed.bootstrap || !managed.governance)
  throw new Error("Unsupported managed payload schema");
export const AGENT_BOOTSTRAP = Object.freeze(managed.bootstrap);
export const BOOTSTRAP_TEXT = AGENT_BOOTSTRAP.text;
export const REQUIRED_GOVERNANCE = Object.freeze(managed.governance);
