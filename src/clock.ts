import type { Clock } from './types.js';

/**
 * The longest delay Node's timers hold, 2^31 - 1 ms (about 24.8 days). Node runs anything longer
 * after 1 ms instead, with only a warning, so options that become a timer are capped here.
 */
export const MAX_TIMER_MS = 2_147_483_647;

// The one place outside tests that reads wall-clock time; algorithms get a Clock injected.
/** The real clock, `Date.now()`. The default wherever a `Clock` is optional. */
export const systemClock: Clock = { now: () => Date.now() };
