import { expect, test } from '@playwright/test';

test('the built demo runs the shipped Lua in the browser, with nothing from another site', async ({
  page,
}) => {
  // wasmoon fetches its .wasm from a CDN unless told otherwise. Block every other origin, and
  // record any attempt, so the test fails if anything leaves the site.
  const offsite: string[] = [];
  await page.route(
    (url) => url.hostname !== 'localhost',
    async (route) => {
      offsite.push(route.request().url());
      await route.abort();
    },
  );
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const wasm = page.waitForResponse((res) => res.url().endsWith('.wasm') && res.ok());

  await page.goto('/');
  await wasm;
  const button = page.getByRole('button', { name: 'Run a check' });
  await expect(button).toBeVisible();

  for (let i = 0; i < 6; i++) await button.click();
  const decisions = page.getByRole('list', { name: 'Decisions' }).getByRole('listitem');
  await expect(decisions).toHaveCount(6);
  // Newest first: five allowed, then the sixth limited.
  await expect(decisions.first()).toHaveText(/^Limited: 0 left/);
  await expect(decisions.nth(1)).toHaveText(/^Allowed: 0 left/);
  await expect(decisions.last()).toHaveText(/^Allowed: 4 left/);

  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});
