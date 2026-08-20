import { readFileSync } from "node:fs";

const readAsset = (name) => JSON.parse(readFileSync(
  new URL(`../managed-assets/${name}`, import.meta.url), "utf8",
));
const bootstrap = readAsset("bootstrap.json");
const governance = readAsset("governance.json");
if (!Number.isSafeInteger(bootstrap?.version) || typeof bootstrap.text !== "string"
    || !Array.isArray(bootstrap.instructions)
    || governance?.id !== "g:lodestar:required-governance"
    || governance?.data?.required !== true || typeof governance?.data?.text !== "string") {
  throw new Error("Canonical managed assets are malformed");
}
export const AGENT_BOOTSTRAP = Object.freeze(bootstrap);
export const BOOTSTRAP_TEXT = AGENT_BOOTSTRAP.text;
export const REQUIRED_GOVERNANCE = Object.freeze(governance);
