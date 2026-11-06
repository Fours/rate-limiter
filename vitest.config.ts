import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // index.ts only re-exports, so it has no lines worth measuring.
      exclude: ['src/index.ts'],
      thresholds: { lines: 90 },
    },
  },
});
