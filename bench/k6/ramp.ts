// Throughput: the arrival rate ramps from 100 to 30,000 req/s (TARGET) over 60 s, or 15 s with
// QUICK=1, over the same 1,000 clients. The analysis takes the busiest second that still had
// p99 under 50 ms and no errors. A probe in T3 saw the stack saturate between 15,000 and
// 20,000 req/s on an M5 Pro, so 10,000 never reached the knee.
import { QUICK, hit, httpOptions } from './lib.ts';

const CLIENTS = 1000;

export const options = {
  ...httpOptions,
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      stages: [{ target: Number(__ENV.TARGET ?? 30_000), duration: QUICK ? '15s' : '60s' }],
      preAllocatedVUs: 500,
      maxVUs: 3000,
    },
  },
};

export default function (): void {
  hit(`ramp-${String(Math.floor(Math.random() * CLIENTS))}`);
}
