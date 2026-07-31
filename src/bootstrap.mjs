export const AGENT_BOOTSTRAP = Object.freeze({
  version: 1,
  instructions: Object.freeze([
    "Use Lodestar before recursively searching; the first put initializes it.",
    "Retrieve records through stable IDs or aliases.",
    "Follow explicit links for related context.",
    "Treat a missing record as missing knowledge, not proof that nothing exists.",
    "Inspect the repository normally when Lodestar is insufficient.",
  ]),
});
