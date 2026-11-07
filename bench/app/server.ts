// Starts the benchmark app. In the stack, each of the three instances runs this with its own
// INSTANCE.
//
// Environment:
//   ALGORITHM   token-bucket, leaky-bucket, fixed-window, sliding-window-log,
//               sliding-window-counter (default) or none (no limiter: the baseline)
//   RULES       rules file, default bench/rules/default.yaml
//   REDIS_URL   required unless ALGORITHM is none
//   INSTANCE    sent back as X-Instance, default "local"
//   PORT        default 3000
//   METRICS     1 to record decisions with prometheusHooks() and serve GET /metrics; 0 or unset
//               for none
import { loadRules } from '@kylewillett/rate-limiter';
import { createApp, parseMetrics } from './app.ts';

const rules = await loadRules(
  process.env.RULES ?? new URL('../rules/default.yaml', import.meta.url).pathname,
);
const algorithm = process.env.ALGORITHM ?? 'sliding-window-counter';
const instance = process.env.INSTANCE ?? 'local';
const metrics = parseMetrics(process.env.METRICS);
const bench = createApp({ algorithm, rules, instance, redisUrl: process.env.REDIS_URL, metrics });

const port = Number(process.env.PORT ?? 3000);
const server = bench.app.listen(port, () => {
  console.log(
    `bench app ${instance} on :${String(port)}, ${algorithm}${metrics ? ', with /metrics' : ''}`,
  );
});

function shutdown() {
  server.close(() => {
    bench.close();
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
