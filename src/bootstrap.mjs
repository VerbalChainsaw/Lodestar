export const AGENT_BOOTSTRAP = Object.freeze({
  version: 1,
  instructions: Object.freeze([
    "At session start, run lodestar start --cwd <cwd> once and use its project, instructions, work, and handoff context.",
    "Retrieve known context with lodestar get, search with lodestar find, and follow relationships with lodestar links.",
    "Treat a missing record as missing Lodestar knowledge, then inspect the repository normally.",
    "Save durable context with lodestar put.",
    "Use lodestar work for advisory presence and the Lodestar handoff flow for cross-session continuation.",
  ]),
});
