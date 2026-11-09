import { expect, test, type Page } from '@playwright/test';

// The built demo in a real browser. Time is paused in most tests, so nothing refills between
// requests and the counts are exact.

const offsite: string[] = [];
const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  offsite.length = 0;
  errors.length = 0;
  // wasmoon fetches its .wasm from a CDN unless told otherwise. Block every other origin, and
  // record any attempt, so a test fails if anything leaves the site.
  await page.route(
    (url) => url.hostname !== 'localhost',
    async (route) => {
      offsite.push(route.request().url());
      await route.abort();
    },
  );
  page.on('pageerror', (err) => errors.push(err.message));
  const wasm = page.waitForResponse((res) => res.url().endsWith('.wasm') && res.ok());
  await page.goto('/');
  await wasm;
  await expect(page.getByRole('button', { name: 'Send one request' })).toBeEnabled();
});

test.afterEach(() => {
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});

const log = (page: Page) => page.getByRole('list', { name: 'Responses' }).getByRole('listitem');

async function pause(page: Page) {
  await page.getByRole('radio', { name: 'Paused' }).check();
}

test('any of the five algorithms answers, showing instance, status and headers', async ({
  page,
}) => {
  await pause(page);
  const names = [
    'Token bucket',
    'Leaky bucket',
    'Fixed window',
    'Sliding window log',
    'Sliding window counter',
  ];
  for (const name of names) {
    await page.getByRole('radio', { name: new RegExp(`^${name}`) }).check();
    await page.getByRole('button', { name: 'Send one request' }).click();
    await expect(log(page).first()).toContainText(`(${name})`);
  }
  // Round robin: #1 to instance 1, #2 to 2, and so on.
  await expect(log(page).first()).toContainText('#5 Instance 2: 200 OK');
  await expect(log(page).last()).toContainText('#1 Instance 1: 200 OK');

  const first = log(page).last();
  await first.getByText('Headers and key').click();
  await expect(first.locator('pre')).toContainText('RateLimit-Limit: 6');
  await expect(first.locator('pre')).toContainText('RateLimit-Remaining: 5');
  await expect(first.locator('pre')).toContainText(/RateLimit-Reset: \d+/);
  await expect(first).toContainText('rl:demo-token-bucket:visitor');
});

test('holding the button sends a stream, and the shared limit holds across instances', async ({
  page,
}) => {
  await pause(page);
  const hold = page.getByRole('button', { name: 'Hold to send many' });
  await hold.hover();
  await page.mouse.down();
  await expect.poll(() => log(page).count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(8);
  await page.mouse.up();
  const sent = await log(page).count();
  // Released: nothing more arrives.
  await page.waitForTimeout(600);
  await expect(log(page)).toHaveCount(sent);

  // Newest first. The first six were allowed, whichever instance answered; the rest refused.
  const texts = await log(page).allInnerTexts();
  const oldestFirst = texts.reverse();
  expect(oldestFirst.slice(0, 6).every((t) => t.includes('200 OK'))).toBe(true);
  expect(oldestFirst.slice(6).every((t) => t.includes('429 Too Many Requests'))).toBe(true);
  expect(oldestFirst.slice(0, 3).map((t) => /Instance (\d)/.exec(t)?.[1])).toEqual(['1', '2', '3']);

  const refused = log(page).first();
  await refused.getByText('Headers and key').click();
  await expect(refused.locator('pre')).toContainText(/Retry-After: \d+/);
  await expect(refused.locator('pre')).toContainText('{ "error": "rate_limited" }');
});

test('with Redis down, each instance answers alone, and the shared count returns with it', async ({
  page,
}) => {
  await pause(page);
  const send = page.getByRole('button', { name: 'Send one request' });
  await send.click();
  await page.getByRole('switch', { name: /Redis is/ }).uncheck();
  await expect(page.getByRole('switch', { name: 'Redis is down' })).toBeVisible();
  await send.click();
  await expect(log(page).first()).toContainText('Counted by this instance alone');
  await expect(log(page).first()).toContainText('1 of 2 left');
  await expect(page.getByRole('list', { name: 'Instances' })).toContainText('Counting on its own');

  await page.getByRole('switch', { name: /Redis is/ }).check();
  await send.click();
  // The one sent before the outage still counts; the fallback's never reached Redis.
  await expect(log(page).first()).toContainText('4 of 6 left');
});

test('side by side, the fixed window allows twice the limit across an edge, the log never', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Burst across the edge' }).click();
  await expect(page.getByTestId('most-fixed-window')).toHaveText('12');
  await expect(page.getByTestId('most-sliding-window-log')).toHaveText('6');
  await expect(page.getByTestId('summary-fixed-window')).toContainText('Over the limit of 6');
  await expect(page.getByTestId('summary-sliding-window-log')).toContainText(
    'Within the limit of 6',
  );
  const table = page.getByRole('table', { name: 'The same requests, checked by both' });
  await expect(table.getByRole('row', { name: /New 10-second block/ })).toHaveCount(1);
});

test('fits a 375 px screen, with no sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await pause(page);
  await page.getByRole('button', { name: 'Send one request' }).click();
  await log(page).first().getByText('Headers and key').click();
  await page.getByRole('button', { name: 'Burst across the edge' }).click();
  await expect(page.getByTestId('most-fixed-window')).toHaveText('12');
  // A string, since the tests are typed without the DOM library.
  const [scroll, client] = await page.evaluate<[number, number]>(
    '[document.documentElement.scrollWidth, document.documentElement.clientWidth]',
  );
  expect(scroll).toBeLessThanOrEqual(client);
  for (const name of ['Send one request', 'Hold to send many', 'Burst across the edge']) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
  }
});

test('works from the keyboard alone', async ({ page }) => {
  // Tab from the top until `name` has focus, as a keyboard user would.
  const tabTo = async (role: 'button' | 'radio' | 'switch', name: string | RegExp) => {
    const target = page.getByRole(role, { name });
    for (let i = 0; i < 30; i++) {
      if ((await target.and(page.locator(':focus')).count()) === 1) return;
      await page.keyboard.press('Tab');
    }
    throw new Error(`Tab never reached ${String(name)}`);
  };

  await tabTo('radio', /^Token bucket/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: /^Fixed window/ })).toBeChecked();

  await tabTo('button', 'Send one request');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(log(page)).toHaveCount(2);
  await expect(log(page).first()).toContainText('(Fixed window)');

  await tabTo('button', 'Hold to send many');
  await page.keyboard.down(' ');
  await expect.poll(() => log(page).count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(5);
  await page.keyboard.up(' ');
  const sent = await log(page).count();
  await page.waitForTimeout(600);
  await expect(log(page)).toHaveCount(sent);

  await tabTo('switch', /Redis is/);
  await page.keyboard.press('Space');
  await expect(page.getByRole('switch', { name: /Redis is/ })).not.toBeChecked();

  await tabTo('button', 'Burst across the edge');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('most-fixed-window')).not.toHaveText('0');
});
