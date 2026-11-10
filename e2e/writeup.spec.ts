import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { SITE_HOST } from './site.ts';

// The write-up (spec T7), built: reached from the dashboard, nothing leaves the site, every
// section cites a decision record that exists, and the charts render.

const DECISIONS = fileURLToPath(new URL('../docs/decisions/', import.meta.url));
const SECTIONS = ['why-in-the-app', 'in-step', 'algorithms', 'cost', 'outage', 'method', 'more'];

const offsite: string[] = [];
const errors: string[] = [];
const requested: string[] = [];

test.beforeEach(async ({ page }) => {
  offsite.length = 0;
  errors.length = 0;
  requested.length = 0;
  await page.route(
    (url) => url.hostname !== SITE_HOST,
    async (route) => {
      offsite.push(route.request().url());
      await route.abort();
    },
  );
  page.on('request', (req) => requested.push(req.url()));
  page.on('pageerror', (err) => errors.push(err.message));
});

test.afterEach(() => {
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});

test('the dashboard links to it, and it links back', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Project' })
    .getByRole('link', { name: 'How it works' })
    .click();
  await expect(page).toHaveURL(/\/how-it-works\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'How three servers share one rate limit',
  );
  await page
    .getByRole('navigation', { name: 'Project' })
    .getByRole('link', { name: 'Live demo' })
    .click();
  await expect(page.getByRole('button', { name: 'Send one request' })).toBeVisible();
});

test('loads neither wasmoon nor the simulation', async ({ page }) => {
  await page.goto('/how-it-works/');
  await expect(page.locator('.wu-figure svg')).toHaveCount(7);
  expect(requested.filter((url) => url.endsWith('.wasm'))).toEqual([]);
});

test('opens with the summary, before any section', async ({ page }) => {
  await page.goto('/how-it-works/');
  const headings = await page.locator('article h2').allTextContents();
  expect(headings[0]).toBe('In short');
  expect(headings).toHaveLength(SECTIONS.length + 1);
});

test('every section cites a decision record, and every cited record exists', async ({ page }) => {
  await page.goto('/how-it-works/');
  for (const id of SECTIONS) {
    await expect(page.locator(`section#${id} a[data-record]`).first()).toBeAttached();
  }
  const links = await page.locator('a[data-record]').all();
  const hrefs = await Promise.all(links.map(async (a) => (await a.getAttribute('href')) ?? ''));
  expect(hrefs.length).toBeGreaterThan(SECTIONS.length);
  for (const href of new Set(hrefs)) {
    const file = /\/docs\/decisions\/(\d{4}-[\w-]+\.md)$/.exec(href)?.[1];
    expect(file, href).toBeDefined();
    expect(existsSync(`${DECISIONS}${file ?? ''}`), href).toBe(true);
  }
});

test('each chart shows its numbers in a table too', async ({ page }) => {
  await page.goto('/how-it-works/');
  const figure = page.locator('.wu-figure').first();
  await figure.getByText('Show the numbers').click();
  const fixed = figure.getByRole('row', { name: /^Fixed window/ });
  await expect(fixed).toContainText('200');
  await expect(fixed).toContainText('2.00×');
});

test('fits a 375 px screen, with no sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/how-it-works/');
  await expect(page.locator('.wu-figure svg').first()).toBeVisible();
  // A string, since the tests are typed without the DOM library.
  const width = await page.evaluate<number>('document.documentElement.scrollWidth');
  expect(width).toBeLessThanOrEqual(375);
});
