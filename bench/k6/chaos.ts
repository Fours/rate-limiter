// Failure handling (milestone 4, T4): steady traffic while bench/run.ts kills or pauses Redis at
// 20 s and brings it back at 40 s. 500 req/s in all, well under saturation:
//
//   heavy  10 clients at 10 req/s each, five times bench/rules/chaos.yaml's limit (20 per 10 s),
//          so they're denied steadily, by the primary and then by the fallback
//   light  400 req/s spread over 400 clients, about 1 req/s each, half the limit
//
// DURATION (seconds) is set by the runner: 60, or 30 with --quick.
import exec from 'k6/execution';
import { hit, httpOptions } from './lib.ts';

const DURATION = `${__ENV.DURATION ?? '60'}s`;
const HEAVY = 10;
const LIGHT = 400;

export const options = {
  ...httpOptions,
  scenarios: {
    heavy: {
      executor: 'constant-arrival-rate',
      exec: 'heavy',
      rate: HEAVY * 10,
      timeUnit: '1s',
      duration: DURATION,
      // While Redis hangs, each check waits out the 50 ms timeout, so more requests are in
      // flight at once.
      preAllocatedVUs: 50,
      maxVUs: 500,
    },
    light: {
      executor: 'constant-arrival-rate',
      exec: 'light',
      rate: LIGHT,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 100,
      maxVUs: 1000,
    },
  },
};

/** Round robin over the heavy clients, so each sends exactly 10 a second. */
export function heavy(): void {
  hit(`heavy-${String(exec.scenario.iterationInTest % HEAVY)}`);
}

export function light(): void {
  hit(`light-${String(Math.floor(Math.random() * LIGHT))}`);
}
