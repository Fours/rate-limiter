import type { Clock } from './types.js';

// The one place outside tests that reads wall-clock time; algorithms get a Clock injected.
/** The real clock, `Date.now()`. The default wherever a `Clock` is optional. */
export const systemClock: Clock = { now: () => Date.now() };
