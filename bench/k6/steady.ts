// Added latency: a constant 500 req/s (RATE), well below saturation, spread over 1,000 clients.
// 60 s, or 10 s with QUICK=1.
import { QUICK, hit, httpOptions } from './lib.ts';

const CLIENTS = 1000;
const RATE = Number(__ENV.RATE ?? 500);

export const options = {
  ...httpOptions,
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: QUICK ? '10s' : '60s',
      // 100 at 500 req/s, as in T5. At higher rates, enough up front that k6 isn't starting VUs
      // mid-run, which dropped iterations at 15,000 req/s.
      preAllocatedVUs: Math.max(100, Math.ceil(RATE / 15)),
      maxVUs: Math.max(1000, Math.ceil(RATE / 5)),
    },
  },
};

export default function (): void {
  hit(`steady-${String(Math.floor(Math.random() * CLIENTS))}`);
}
