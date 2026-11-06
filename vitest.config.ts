import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Two projects: `npm test` runs unit only and needs no Redis; `npm run test:integration`
    // needs one (npm run redis:up). Coverage runs both, since Redis code is only exercised there.
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/integration/**'],
        },
      },
      {
        // bench/ imports the package by name, as an app would. Point that at src/ so its tests
        // run against the code under test, not whatever dist/ was last built.
        resolve: {
          alias: {
            '@kylewillett/rate-limiter': fileURLToPath(new URL('src/index.ts', import.meta.url)),
          },
        },
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Only TypeScript: Lua isn't measured (the behaviour suite covers it), and v8 can't parse it.
      include: ['src/**/*.ts'],
      // index.ts only re-exports, so it has no lines worth measuring.
      exclude: ['src/index.ts'],
      thresholds: { lines: 90 },
    },
  },
});
