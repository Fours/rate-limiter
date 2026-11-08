// Accuracy at window edges: 10 clients, one per VU. Around each chosen boundary of the 10 s grid
// (where the fixed window resets) a client sends a burst of LIMIT requests starting 400 to 650 ms
// before it, and another 50 ms after it, with a trickle of about 5 req/s in between. Bursts fall on every other
// boundary, so a burst's requests age out of a sliding window mid-trickle rather than during the
// next burst. That keeps the moments when a slot frees up far apart, so a small timing error
// can't make two requests look like they share a window. 6 bursts, or 2 with QUICK=1.
import { QUICK, hit, httpOptions, sleepUntil } from './lib.ts';

const WINDOW_MS = Number(__ENV.WINDOW_MS ?? 10_000);
const LIMIT = Number(__ENV.LIMIT ?? 100);
const BURSTS = QUICK ? 2 : 6;
const TRICKLE_MS = 200;

export const options = {
  ...httpOptions,
  scenarios: {
    edges: {
      executor: 'per-vu-iterations',
      vus: 10,
      iterations: 1,
      maxDuration: QUICK ? '60s' : '3m',
    },
  },
};

// Every VU computes the same first boundary, at least 1 s ahead, so the clients burst together.
const first = Math.ceil((Date.now() + 1000) / WINDOW_MS) * WINDOW_MS;

export default function (): void {
  const client = `edge-${String(__VU)}`;
  for (let k = 0; k < BURSTS; k++) {
    const boundary = first + k * 2 * WINDOW_MS;
    // The trickle stops at its first slot past this, so the burst starts up to one jittered
    // trickle step (250 ms) earlier. Kept as is so 0008's edges data stays comparable (milestone
    // 5, T0).
    trickleUntil(client, boundary - 400);
    for (let i = 0; i < LIMIT; i++) hit(client);
    sleepUntil(boundary + 50);
    for (let i = 0; i < LIMIT; i++) hit(client);
  }
  trickleUntil(client, Date.now() + 1000);
}

// Jittered around TRICKLE_MS. A fixed 200 ms divides the 10 s window exactly, so trickle requests
// would recur exactly one window apart, landing on the very millisecond an old request ages out
// of a sliding window. Found in T3, when that made the log look 1 over its limit.
function trickleUntil(client: string, end: number): void {
  for (let next = Date.now(); next < end; next += TRICKLE_MS * (0.75 + Math.random() / 2)) {
    sleepUntil(next);
    hit(client);
  }
}
