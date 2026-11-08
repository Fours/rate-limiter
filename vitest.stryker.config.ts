import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// For mutation testing (npm run mutate): the unit and integration projects, so the Redis
// adapters and script runner are covered too. Not the package project, which runs against a
// build. The integration tests need the test Redis (npm run redis:up). Not mergeConfig, which
// would append these projects to the base's instead of replacing them.
// One seed for the property tests (0034), so two mutation runs try the same histories and their
// survivors can be compared. The test workers inherit it.
process.env.FC_SEED ??= '20261108';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: (base.test?.projects ?? []).filter(
      (p) => typeof p === 'object' && 'test' in p && p.test.name !== 'package',
    ),
  },
});
