import type { AlgorithmName } from './redis/scripts.ts';

/** How each algorithm is introduced on the page, in plain words, for the demo's 6 per 10 s. */
export const ALGORITHM_COPY: Record<AlgorithmName, { name: string; summary: string }> = {
  'token-bucket': {
    name: 'Token bucket',
    summary:
      'A bucket holds 6 tokens and refills one every 1.7 seconds. Each request takes a token, so short bursts are fine until it runs dry.',
  },
  'leaky-bucket': {
    name: 'Leaky bucket',
    summary:
      'Spaces requests out evenly: one every 1.7 seconds, with no bursts. Send two at once and the second waits.',
  },
  'fixed-window': {
    name: 'Fixed window',
    summary:
      'Counts requests in 10-second blocks on the clock. The count starts again at each block’s edge.',
  },
  'sliding-window-log': {
    name: 'Sliding window log',
    summary:
      'Remembers when every request arrived and allows 6 in any 10 seconds. Exact, but stores every request.',
  },
  'sliding-window-counter': {
    name: 'Sliding window counter',
    summary:
      'Estimates the last 10 seconds from this block’s count and the one before. Nearly as accurate as the log, for two numbers.',
  },
};
