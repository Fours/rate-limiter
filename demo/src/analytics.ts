// PostHog, the portfolio's way (spec open question 5): posthog-js loads as its own async chunk on
// the next idle frame, so it stays off the critical path. The automatic pageview fires at init,
// so the first view is still captured, a moment after load.

const posthogKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;

export function initAnalytics(): void {
  // No key, as in CI and most local builds: nothing loads. Under automation (Playwright sets
  // navigator.webdriver) a build made with a key would send test runs to PostHog, and the e2e
  // test fails on any request that leaves the site.
  if (posthogKey === undefined || posthogKey === '' || navigator.webdriver) return;

  const start = () =>
    import('posthog-js').then(({ default: posthog }) => {
      posthog.init(posthogKey, {
        api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
        defaults: '2025-05-24',
        capture_pageview: true,
      });
    });

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => void start(), { timeout: 2000 });
  } else {
    window.setTimeout(() => void start(), 1);
  }
}
