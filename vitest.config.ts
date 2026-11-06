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
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // index.ts only re-exports, so it has no lines worth measuring.
      exclude: ['src/index.ts'],
      thresholds: { lines: 90 },
    },
  },
});
