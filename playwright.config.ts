import { defineConfig, devices } from '@playwright/test';

// One smoke test of the built demo in a real browser (spec open question 6): it proves wasmoon's
// .wasm loads through Vite, which no Node test can. `npm run test:e2e` builds first.
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['github']],
  use: { baseURL: 'http://localhost:4173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run demo:preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: process.env.CI === undefined,
    timeout: 30_000,
  },
});
