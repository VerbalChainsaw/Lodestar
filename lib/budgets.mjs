export const BUDGETS_V1 = Object.freeze({
  start: Object.freeze({
    maxBytes: 5 * 1024,
    maxRequired: 32,
    maxAvailable: 64,
  }),
  find: Object.freeze({
    maxResults: 8,
  }),
  resolve: Object.freeze({
    defaultDepth: 1,
    maxDepth: 3,
    maxRecords: 24,
    maxBytes: 16 * 1024,
  }),
});
