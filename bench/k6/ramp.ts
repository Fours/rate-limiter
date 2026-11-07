// Throughput: the arrival rate ramps from 100 to 60,000 req/s (TARGET) over 60 s, or 15 s with
// QUICK=1, over the same 1,000 clients. The analysis takes the busiest second that still had
// p99 under 50 ms, no errors and no iterations k6 dropped.
//
// bench/run.ts runs this with LOG=0 and k6's JSON output: logging every request capped k6 near
// 20,000 req/s, below the stack's knee. Without it, a T5 probe on an M5 Pro saw the knee between
// 30,000 and 35,000 req/s, with nginx's one worker at a full core. 2,000 VUs up front, because
// starting VUs mid-ramp made k6 drop iterations well before the stack was busy.
import { QUICK, hit, httpOptions } from './lib.ts';

const CLIENTS = 1000;

export const options = {
  ...httpOptions,
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      stages: [{ target: Number(__ENV.TARGET ?? 60_000), duration: QUICK ? '15s' : '60s' }],
      preAllocatedVUs: 2000,
      maxVUs: 6000,
    },
  },
};

export default function (): void {
  hit(`ramp-${String(Math.floor(Math.random() * CLIENTS))}`);
}
