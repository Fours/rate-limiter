// For a sliding-window-log run: per client, the shortest t-span holding limit+1 allowed requests,
// and the limiter times at its two ends. Under windowMs - 2 means the analysis sees 101.
import { readFileSync, globSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const W = 10000, L = 100;
for (const dir of process.argv.slice(2)) {
  const f = globSync(`${dir}/*/sliding-window-log/run-1/requests.jsonl.gz`)[0];
  const rs = gunzipSync(readFileSync(f)).toString().trim().split('\n').map(JSON.parse);
  let best;
  const byClient = Map.groupBy(rs.filter((r) => r.status === 200), (r) => r.client);
  for (const [c, own] of byClient) {
    own.sort((a, b) => a.t - b.t);
    for (let i = 0; i + L < own.length; i++) {
      const span = own[i + L].t - own[i].t;
      if (!best || span < best.span) best = { c, span, first: own[i], last: own[i + L] };
    }
  }
  const lim = rs.map((r) => r.limiterMs).filter((x) => x !== undefined).sort((a, b) => a - b);
  console.log(dir.split('/').pop(), `shortest ${L + 1}-span ${best.span} ms`, `ends limiterMs ${best.first.limiterMs} / ${best.last.limiterMs}`,
    `| limiterMs p50 ${lim[lim.length >> 1]} p99 ${lim[Math.floor(lim.length * 0.99)]} max ${lim.at(-1)}`);
}
