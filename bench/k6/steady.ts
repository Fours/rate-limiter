// Added latency: a constant 500 req/s (RATE), well below saturation, spread over 1,000 clients.
// 60 s, or 10 s with QUICK=1.
import { QUICK, hit, httpOptions } from './lib.ts';

const CLIENTS = 1000;

export const options = {
  ...httpOptions,
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE ?? 500),
      timeUnit: '1s',
      duration: QUICK ? '10s' : '60s',
      preAllocatedVUs: 100,
      maxVUs: 1000,
    },
  },
};

export default function (): void {
  hit(`steady-${String(Math.floor(Math.random() * CLIENTS))}`);
}
