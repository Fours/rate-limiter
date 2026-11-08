// Mutation testing, npm run mutate (decision 0033). Mutates the TypeScript in src/ and runs the
// unit and integration tests against each mutant, so the test Redis must be up
// (npm run redis:up). Stryker can't mutate Lua: npm run mutate:lua covers the scripts.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.stryker.config.ts' },
  // index.ts only re-exports.
  mutate: ['src/**/*.ts', '!src/index.ts'],
  // Runs only the tests that cover each mutant, which keeps a full run to minutes.
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'html', 'json', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  concurrency: 4,
  thresholds: { high: 90, low: 80, break: null },
  tempDirName: '.stryker-tmp',
};
