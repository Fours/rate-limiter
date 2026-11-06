// The only public entry point: everything consumers can import is exported from here.
export type { Algorithm, Clock, Decision, Rule } from './types.js';
export { systemClock } from './clock.js';
