import type { Clock } from './types.js';

// The one place outside tests that reads wall-clock time; algorithms get a Clock injected.
export const systemClock: Clock = { now: () => Date.now() };
