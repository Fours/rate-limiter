import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, LOCAL } from './e2e/site.ts';

// One smoke test of the built demo in a real browser (spec open question 6): it proves wasmoon's
// .wasm loads through Vite, which no Node test can. `npm run test:e2e` builds first. With
// E2E_BASE_URL set, the same tests run against that site instead, and nothing is served locally.
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['github']],
  use: { baseURL: BASE_URL },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: LOCAL
    ? {
        command: 'npm run demo:preview -- --port 4173 --strictPort',
        url: BASE_URL,
        reuseExistingServer: process.env.CI === undefined,
        timeout: 30_000,
      }
    : [],
});
