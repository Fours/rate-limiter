// Shared by every scenario. Each request is logged as one line, which bench/run.ts turns into a
// RequestRecord (bench/analysis.ts):
//
//   REC <client> <receivedAt> <sentAt> <status> <e2eMs> <limiterMs> <instance> <source>
//
// instance is X-Instance, and source is X-RateLimit-Source (primary or fallback), added in
// milestone 4 for the chaos scenario. Older results have only the first six fields.
//
// receivedAt comes from the app's X-Received-At header and is what windows are timed by; sentAt
// is k6's own clock just before sending, kept for comparison. "-" marks a missing value, such as
// a request that failed before any response.
//
// Logged by the script rather than read from k6's JSON output: a probe on k6 2.3.0 showed its
// JSON timestamps mark when the response arrived, not when the request was sent.
import { sleep } from 'k6';
import http, { type RefinedResponse, type ResponseType } from 'k6/http';

export const BASE_URL = __ENV.BASE_URL ?? 'http://lb';
export const QUICK = __ENV.QUICK === '1';
/**
 * LOG=0 turns the REC lines off. The ramp needs that: k6 serialises console output, which capped
 * it near 20,000 req/s, so the ramp reads k6's JSON output instead (bench/run.ts).
 */
const LOG = __ENV.LOG !== '0';

// A 429 is the limiter working, so k6 shouldn't count it as a failed request.
http.setResponseCallback(http.expectedStatuses(200, 429));

export const httpOptions = {
  discardResponseBodies: true,
};

export function hit(client: string): number {
  const sentAt = Date.now();
  const res = http.get(`${BASE_URL}/work`, {
    headers: { 'x-api-key': client },
    tags: { name: 'work' },
    timeout: '10s',
  });
  if (LOG) log(client, sentAt, res);
  return res.status;
}

function log(client: string, sentAt: number, res: RefinedResponse<ResponseType | undefined>): void {
  const receivedAt = res.headers['X-Received-At'] ?? '-';
  const timing = /rl;dur=([\d.]+)/.exec(res.headers['Server-Timing'] ?? '');
  const limiterMs = timing?.[1] ?? '-';
  const e2eMs = res.timings.duration.toFixed(3);
  const instance = res.headers['X-Instance'] ?? '-';
  const source = res.headers['X-Ratelimit-Source'] ?? '-';
  console.log(
    `REC ${client} ${receivedAt} ${String(sentAt)} ${String(res.status)} ${e2eMs} ${limiterMs} ${instance} ${source}`,
  );
}

/** Waits until the given epoch ms by this container's clock. */
export function sleepUntil(epochMs: number): void {
  const ms = epochMs - Date.now();
  if (ms > 0) sleep(ms / 1000);
}
