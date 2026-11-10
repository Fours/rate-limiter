// The design write-up (spec T7): the decision records told as one story, in the order a reader
// needs it, with the benchmark numbers as charts. The data comes in as a prop, read from
// docs/decisions/data/ at build time, so every number here is the one the records quote.
import { ALGORITHM_COPY } from '../algorithms.ts';
import { AppBar } from '../components/AppBar.tsx';
import { NPM_URL, REPO_URL } from '../links.ts';
import { BarChart, Figure, LineChart, SERIES_1, SERIES_2, type BarRow } from './charts.tsx';
import type { AlgorithmName, BenchAlgorithm, ChaosRow, WriteupData } from './data.ts';
import { Record } from './Record.tsx';
import { RECORDS } from './records.ts';

const nameOf = (a: BenchAlgorithm) => (a === 'none' ? 'No limiter' : ALGORITHM_COPY[a].name);
const lower = (a: AlgorithmName) => ALGORITHM_COPY[a].name.toLowerCase();

const whole = (n: number) => n.toLocaleString('en-US');
const ms = (n: number) => `${n.toFixed(2)} ms`;
const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
const bytes = (n: number) =>
  n < 1000
    ? `${String(n)} B`
    : `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: n < 10_000 ? 1 : 0 })} KB`;

function find<T extends { algorithm: BenchAlgorithm }>(rows: readonly T[], a: BenchAlgorithm): T {
  const row = rows.find((r) => r.algorithm === a);
  // The loader checks every algorithm is there, so a miss is a bug in this page.
  if (row === undefined) throw new Error(`No ${a} row in the write-up's data`);
  return row;
}

const SECTIONS = [
  ['why-in-the-app', 'Why limit in the app'],
  ['in-step', 'Keeping three servers in step'],
  ['algorithms', 'Choosing an algorithm'],
  ['cost', 'What Redis costs per request'],
  ['outage', 'When Redis goes away'],
  ['method', 'How the numbers were measured'],
  ['more', 'Other decisions'],
] as const;

export function WriteUp({ data }: { data: WriteupData }) {
  const { edges, steady, ramp, memory, chaos, baseline, metrics } = data;
  const peak = (a: AlgorithmName) => find(edges.rows, a).peak;
  const mem = (a: AlgorithmName, limit: number) =>
    memory.find((r) => r.algorithm === a && r.limit === limit)?.bytes ?? 0;
  const logAt1000 = mem('sliding-window-log', 1000);
  const counterBytes = mem('sliding-window-counter', 1000);
  const p99s = steady.rows.flatMap((r) => (r.limiterP99 === null ? [] : [r.limiterP99]));
  const limited = ramp.filter((r) => r.algorithm !== 'none');
  const throughputs = limited.map((r) => r.throughput);
  const redisCpus = limited.map((r) => r.redisCpu);
  const none = find(ramp, 'none');
  const fast = baseline[baseline.length - 1];
  const worst = (rows: readonly ChaosRow[], phase: 0 | 1 | 2) =>
    Math.max(...rows.map((r) => r.p99[phase]));
  const failed = [...chaos.killed, ...chaos.paused].reduce((n, r) => n + r.failed, 0);
  const recoveries = chaos.killed.map((r) => r.recoveryMs);

  return (
    <div className="writeup">
      <AppBar page="how-it-works" />
      <main className="wu-main">
        <article className="wu-article">
          <header className="wu-head">
            <p className="wu-eyebrow">Design write-up</p>
            <h1>How three servers share one rate limit</h1>
            <p className="wu-lede">
              The design behind{' '}
              <a href={NPM_URL} target="_blank" rel="noreferrer">
                <code>@kylewillett/rate-limiter</code>
              </a>
              , a rate limiter for Express apps that run on more than one server. Each choice links
              to its decision record, which has the alternatives and the evidence in full.
            </p>
          </header>

          <section className="wu-summary" aria-labelledby="summary">
            <h2 id="summary">In short</h2>
            <p>
              A rate limiter stops one visitor from sending more requests than a site allows, say
              100 a minute, so nobody can hog or overwhelm it. That’s simple on one server. A busy
              site runs several copies of itself, though, and each visitor’s requests are spread
              across all of them, so the copies have to keep one shared count. Here they keep it in
              Redis, a fast shared database, and each check is a single step that two servers can’t
              interleave. Five ways of counting were measured against each other. They cost the
              same, so the choice comes down to accuracy and memory. And when Redis goes down, the
              site stays up: each server keeps its own rough count until Redis is back.
            </p>
            <p>
              <a href="../">Try it in the live demo</a>, where three simulated servers share one
              limit in your browser, running the same code.
            </p>
          </section>

          <nav className="wu-toc" aria-label="Contents">
            <ol>
              {SECTIONS.map(([id, title]) => (
                <li key={id}>
                  <a href={`#${id}`}>{title}</a>
                </li>
              ))}
            </ol>
          </nav>

          <section id="why-in-the-app" aria-labelledby="why-in-the-app-h">
            <h2 id="why-in-the-app-h">Why limit in the app</h2>
            <p>
              A limit can be enforced at the edge, by the load balancer, or inside the app. The edge
              is cheaper, but it only knows addresses. A rule like “100 an hour on the free plan,
              1,000 on pro” needs to know which account sent the request, and only the app knows
              that. So the limiter is Express middleware that runs in every copy of the app{' '}
              <Record id="0004" />.
            </p>
            <p>
              The test stack is nginx in front of three app instances and one Redis. A check script
              sends 30 requests from one client, round robin across the three, and exactly 10 get
              through, for each of the five algorithms, while a second client keeps its own limit.
              nginx’s own limiter couldn’t do that, because it can’t see who the client is{' '}
              <Record id="0004" />.
            </p>
            <p>
              Being in the app also decides what the package depends on. Apps that use Redis already
              have a client, set up with their own connection, TLS and retries, so the limiter takes
              the app’s client through a two-method interface rather than opening a connection of
              its own <Record id="0013" />. The package has no runtime dependencies at all: Express
              is a peer dependency.
            </p>
          </section>

          <section id="in-step" aria-labelledby="in-step-h">
            <h2 id="in-step-h">Keeping three servers in step</h2>
            <p>
              Sharing a count is easy to get wrong. The obvious version reads the count, decides,
              and writes it back. Two servers can both read “49 of 50 used”, both allow a request,
              and both write 50. Under real concurrency that isn’t an edge case. A test sends 200
              checks at once over four connections against a limit of 50. The read-then-write
              version allowed <strong>all 200, every time</strong>, because every read landed before
              any write <Record id="0006" />.
            </p>
            <p>
              So each check is one Lua script that runs inside Redis. Redis runs scripts one at a
              time, so the read, the decision and the write can’t be interleaved with another
              server’s. The same test allows exactly 50 with every algorithm. Scripts are sent once
              and then called by their hash, so a check is a single round trip <Record id="0006" />.
            </p>
            <p>
              Time needs the same care. Every algorithm compares “now” with when earlier requests
              arrived, and if each server sends its own clock, a server that’s two seconds fast
              hands out two seconds of extra allowance. So the scripts read the time from Redis
              itself, and the app never sends one. In a test with two servers’ clocks set two
              seconds apart, app time let a second request through for all five algorithms, and
              Redis time refused it for all five <Record id="0007" />.
            </p>
            <p>
              Behind all of this is one small interface: every algorithm, in memory or in Redis,
              answers <code>check(key, rule)</code> with allowed or not, how many are left, and when
              to retry. The middleware never changes to suit one algorithm, and the same middleware
              tests pass against all six implementations <Record id="0001" />. A script also tags
              what it stores, so moving a rule to a different algorithm starts each client fresh
              instead of misreading the old state <Record id="0016" />, and changing a rule’s limit
              keeps each client’s progress <Record id="0031" />.
            </p>
          </section>

          <section id="algorithms" aria-labelledby="algorithms-h">
            <h2 id="algorithms-h">Choosing an algorithm</h2>
            <p>There are five standard ways to count, and the package ships all of them:</p>
            <ul className="wu-list">
              <li>
                <strong>Token bucket.</strong> A bucket of tokens refills steadily. Each request
                takes one, so a quiet client can save up a burst.
              </li>
              <li>
                <strong>Leaky bucket.</strong> Requests are spaced out evenly, one per interval,
                with no bursts at all, unless a rule allows one <Record id="0014" />{' '}
                <Record id="0022" />.
              </li>
              <li>
                <strong>Fixed window.</strong> Count requests in blocks of time, such as each minute
                on the clock, and start again at each block’s edge.
              </li>
              <li>
                <strong>Sliding window log.</strong> Remember when every request arrived and allow
                the limit in any window, measured back from now. Exact.
              </li>
              <li>
                <strong>Sliding window counter.</strong> Estimate the last window from this block’s
                count and the one before. Nearly exact, for two numbers.
              </li>
            </ul>
            <p>
              The benchmarks ran each one on the same stack at a steady 500 requests a second, with
              traffic ramped up until the stack saturated, and with bursts timed to land on each
              side of a window’s edge. On speed they couldn’t be told apart (the next section has
              the numbers), so the choice comes down to accuracy and memory <Record id="0008" />.
            </p>

            <h3>Accuracy: bursts at a window’s edge</h3>
            <p>
              In the edges test, each of 10 clients sends its whole limit just before a window ends
              and again just after the next one begins. The fixed window counts those as two
              separate windows, so in any {edges.windowMs / 1000} seconds that straddle the edge it
              lets through <strong>{peak('fixed-window')}</strong> against a limit of {edges.limit},
              in every run. The sliding window log never went over {peak('sliding-window-log')}. The
              counter peaked at {peak('sliding-window-counter')} (median of three runs){' '}
              <Record id="0008" />.
            </p>

            <Figure
              title={`Most requests one client got in any ${String(edges.windowMs / 1000)} seconds`}
              description={`Bursts on each side of a window’s edge, against a limit of ${String(edges.limit)}. Median of three runs.`}
              source={
                <>
                  Source: the edges benchmark, <Record id="0008" />. Method: <Record id="0017" />.
                </>
              }
              table={{
                columns: ['Algorithm', 'Peak in any window', 'Over the limit', 'False denials'],
                rows: edges.rows.map((r) => [
                  nameOf(r.algorithm),
                  whole(r.peak),
                  `${(r.peak / edges.limit).toFixed(2)}×`,
                  pct(r.falseDenials),
                ]),
              }}
            >
              <BarChart
                label={`Peak requests in any window: ${edges.rows
                  .map((r) => `${nameOf(r.algorithm)} ${String(r.peak)}`)
                  .join(', ')}, against a limit of ${String(edges.limit)}.`}
                rows={edges.rows.map((r) => ({ label: nameOf(r.algorithm), values: [r.peak] }))}
                series={[{ name: 'Peak in any window', color: SERIES_1 }]}
                format={whole}
                reference={{ value: edges.limit, label: `Limit ${String(edges.limit)}` }}
              />
            </Figure>

            <p>
              Over time, the difference looks like this. Each dot is a request that was allowed, at
              the height of how many that client had been allowed in the 10 seconds up to it. The
              fixed window spikes to twice the limit at every edge; the log runs up to the limit and
              stops. You can make the fixed window do this yourself in the{' '}
              <a href="../#fixed-window">demo’s side-by-side view</a>.
            </p>

            <EdgesTimeline data={data} />

            <p>
              The token bucket peaked at {peak('token-bucket')}, which is what a bucket is for: a
              client that was quiet can spend a full bucket and then its refill. The leaky bucket
              never exceeded the limit but refused requests an exact window would allow,{' '}
              {pct(find(edges.rows, 'leaky-bucket').falseDenials)} of all requests here, because it
              allows no burst by default. Rules can give either bucket a <code>burst</code>{' '}
              <Record id="0022" />.
            </p>

            <h3>Memory: what each key costs in Redis</h3>
            <p>
              The log’s exactness has a price. It stores one entry per allowed request, so its
              memory grows with the limit, while every other algorithm stores a few numbers. At
              1,000 a minute, one client’s key costs {bytes(logAt1000)} for the log and{' '}
              {bytes(counterBytes)} for the counter: {whole(Math.round(logAt1000 / counterBytes))}{' '}
              times as much. There’s also a cliff at 128 entries, where Redis switches the log’s
              sorted set from a compact layout to a skiplist <Record id="0008" />.
            </p>

            <Figure
              title="Redis memory for one client’s key"
              description="Bytes per key after a full window of requests, by the rule’s limit per minute. Log scale."
              source={
                <>
                  Source: <code>MEMORY USAGE</code> on Redis 7.4, <Record id="0008" />.
                </>
              }
              table={{
                columns: [
                  'Algorithm',
                  ...[10, 100, 127, 128, 1000].map((l) => `${whole(l)} a minute`),
                ],
                rows: (
                  [
                    'token-bucket',
                    'leaky-bucket',
                    'fixed-window',
                    'sliding-window-log',
                    'sliding-window-counter',
                  ] as const
                ).map((a) => [
                  nameOf(a),
                  ...[10, 100, 127, 128, 1000].map((l) => bytes(mem(a, l))),
                ]),
              }}
            >
              <LineChart
                label={`Memory per key. Sliding window log: ${[10, 100, 127, 128, 1000]
                  .map((l) => `${bytes(mem('sliding-window-log', l))} at ${String(l)}`)
                  .join(', ')}. Sliding window counter: ${bytes(counterBytes)} at every limit.`}
                series={(['sliding-window-log', 'sliding-window-counter'] as const).map((a, i) => ({
                  name: nameOf(a),
                  color: i === 0 ? SERIES_2 : SERIES_1,
                  points: memory
                    .filter((r) => r.algorithm === a)
                    .map((r) => [r.limit, r.bytes] as const),
                }))}
                categories={[10, 100, 127, 128, 1000]}
                x={{ min: 10, max: 1000, ticks: [10, 100, 127, 128, 1000], format: whole }}
                y={{ min: 100, max: 200_000, ticks: [100, 1000, 10_000, 100_000], format: bytes }}
                log
                markers
                xTitle="Limit per minute"
              />
            </Figure>

            <p>
              So the sliding window counter is the recommended algorithm for Redis: near-exact, with
              a small, flat cost. Its weakness is bursty traffic, where it assumed the previous
              window’s requests were spread evenly. In the edges test it refused requests an exact
              window would allow: {pct(find(edges.rows, 'sliding-window-counter').falseDenials)} of
              all requests, against none at a steady rate. The log is worth its memory where going
              over is unacceptable, such as login attempts or paid quotas, and it’s cheapest under
              128 per window <Record id="0008" />. Since speed doesn’t differ, mixing them costs
              nothing: each rule can name its own algorithm <Record id="0023" />.
            </p>
          </section>

          <section id="cost" aria-labelledby="cost-h">
            <h2 id="cost-h">What Redis costs per request</h2>
            <p>
              Every check is a network round trip to Redis, on every request. That sounds expensive,
              so it was measured. At a steady 500 requests a second, the limiter’s own time at the
              99th percentile was {ms(Math.min(...p99s))} to {ms(Math.max(...p99s))} for every
              algorithm, and the gaps between algorithms were no bigger than the spread between runs
              of one <Record id="0008" />.
            </p>

            <Figure
              title="Time the limiter adds to a request"
              description={`99th percentile of the limiter’s own time, at a steady 500 requests a second. Median of three runs.`}
              source={
                <>
                  Source: the steady benchmark, timed inside the app with <code>Server-Timing</code>
                  , <Record id="0008" /> <Record id="0017" />.
                </>
              }
              table={{
                columns: [
                  'Algorithm',
                  'Limiter p50',
                  'Limiter p99',
                  'End-to-end p50',
                  'End-to-end p99',
                ],
                rows: steady.rows.map((r) => [
                  nameOf(r.algorithm),
                  r.limiterP50 === null ? '–' : ms(r.limiterP50),
                  r.limiterP99 === null ? '–' : ms(r.limiterP99),
                  ms(r.e2eP50),
                  ms(r.e2eP99),
                ]),
              }}
            >
              <BarChart
                label={`Limiter p99: ${steady.rows
                  .flatMap((r) =>
                    r.limiterP99 === null ? [] : [`${nameOf(r.algorithm)} ${ms(r.limiterP99)}`],
                  )
                  .join(', ')}.`}
                rows={steady.rows.flatMap((r): BarRow[] =>
                  r.limiterP99 === null
                    ? []
                    : [{ label: nameOf(r.algorithm), values: [r.limiterP99] }],
                )}
                series={[{ name: 'Limiter p99', color: SERIES_1 }]}
                format={ms}
              />
            </Figure>

            <p>
              At full load the story is the same. With traffic ramped up until requests slowed,
              every algorithm sustained {whole(Math.min(...throughputs))} to{' '}
              {whole(Math.max(...throughputs))} requests a second, against {whole(none.throughput)}{' '}
              with no limiter. The bottleneck was the three Node apps, each at a full CPU core, not
              Redis, which used {Math.min(...redisCpus)}% to {Math.max(...redisCpus)}% of one. The
              log loads Redis most, since every check trims and counts a sorted set{' '}
              <Record id="0008" />.
            </p>

            <Figure
              title="Throughput, and how hard Redis worked for it"
              description="The busiest second with a 99th percentile under 50 ms and no errors, as traffic ramped up; and Redis’s CPU in that second. Median of three runs."
              source={
                <>
                  Source: the ramp benchmark on one laptop, for comparing algorithms, not capacity
                  planning, <Record id="0008" /> <Record id="0017" />.
                </>
              }
              table={{
                columns: ['Algorithm', 'Requests a second', 'Redis CPU (% of a core)'],
                rows: ramp.map((r) => [
                  nameOf(r.algorithm),
                  whole(r.throughput),
                  `${String(r.redisCpu)}%`,
                ]),
              }}
            >
              <div className="wu-pair">
                <div>
                  <p className="wu-pair-title">Requests a second</p>
                  <BarChart
                    label={`Throughput: ${ramp
                      .map((r) => `${nameOf(r.algorithm)} ${whole(r.throughput)}`)
                      .join(', ')} requests a second.`}
                    rows={ramp.map((r) => ({
                      label: nameOf(r.algorithm),
                      values: [r.throughput],
                      baseline: r.algorithm === 'none',
                    }))}
                    series={[{ name: 'Requests a second', color: SERIES_1 }]}
                    format={(n) => `${(n / 1000).toFixed(1)}K`}
                  />
                </div>
                <div>
                  <p className="wu-pair-title">Redis CPU, % of one core</p>
                  <BarChart
                    label={`Redis CPU at the peak: ${ramp
                      .map((r) => `${nameOf(r.algorithm)} ${String(r.redisCpu)}%`)
                      .join(', ')}.`}
                    rows={ramp.map((r) => ({
                      label: nameOf(r.algorithm),
                      values: [r.redisCpu],
                      baseline: r.algorithm === 'none',
                    }))}
                    series={[{ name: 'Redis CPU', color: SERIES_1 }]}
                    format={(n) => `${String(n)}%`}
                  />
                </div>
              </div>
            </Figure>

            <p>
              That settled a tempting optimisation. Each server could reserve a batch of tokens from
              Redis and hand them out locally, saving round trips. But the round trip it saves is
              small: at {whole(fast?.rate ?? 0)} requests a second the limiter took{' '}
              {ms(fast?.limiterP50 ?? 0)} at the median and {ms(fast?.limiterP99 ?? 0)} at the 99th
              percentile, still one round trip per request. Redis wasn’t the bottleneck either. And
              batches cost exactness: with three servers and batches of 20, up to 57 extra requests
              could get through a window of 100. So it wasn’t built. If Redis ever becomes slow to
              reach, the first step is caching denials, which lets nothing extra through{' '}
              <Record id="0009" />.
            </p>
            <p>
              Metrics follow the same rule of not costing the request. The core has no metrics
              dependency: it calls optional hooks, which can’t break a request <Record id="0019" />,
              and a separate entry point turns them into Prometheus metrics. At{' '}
              {whole(fast?.rate ?? 0)} requests a second the limiter’s 99th percentile was{' '}
              {ms(metrics.without.limiterP99 ?? 0)} without metrics and{' '}
              {ms(metrics.with.limiterP99 ?? 0)} with them, within the spread between runs{' '}
              <Record id="0005" />.
            </p>
          </section>

          <section id="outage" aria-labelledby="outage-h">
            <h2 id="outage-h">When Redis goes away</h2>
            <p>
              A shared count means a shared dependency. If Redis is down, the limiter can refuse
              every request (fail closed) or let them through (fail open). Failing closed turns a
              Redis outage into a full site outage, so the limiter fails open, but not without a
              limit: each server switches to its own in-memory count, at roughly the limit divided
              by the number of servers <Record id="0010" />. Every check gets 50 ms; past that, or
              on an error, the in-memory count answers. That lives in the middleware, around any
              algorithm, so it works the same for all five <Record id="0018" />.
            </p>
            <p>
              The chaos test ran traffic through the stack and took Redis away for about 20 seconds,
              in two ways: killed outright, and frozen so that it never answers. Five algorithms,
              two kinds of outage, three runs each.{' '}
              <strong>
                {failed === 0 ? 'Not one request failed' : `${whole(failed)} requests failed`}
              </strong>{' '}
              in any of the 30 runs <Record id="0010" />.
            </p>

            <Figure
              title="Response time before, during and after an outage"
              description="End-to-end 99th percentile. Each bar is the slowest of the five algorithms, which were within a few tenths of a millisecond of each other."
              source={
                <>
                  Source: the chaos test, 500 requests a second, <Record id="0010" />.
                </>
              }
              table={{
                columns: [
                  'Algorithm',
                  'Killed: before / during / after',
                  'Paused: before / during / after',
                  'Recovery after a kill',
                ],
                rows: chaos.killed.map((k) => {
                  const p = find(chaos.paused, k.algorithm);
                  return [
                    nameOf(k.algorithm),
                    k.p99.map((v) => v.toFixed(2)).join(' / ') + ' ms',
                    p.p99.map((v) => v.toFixed(2)).join(' / ') + ' ms',
                    `${(k.recoveryMs / 1000).toFixed(1)} s`,
                  ];
                }),
              }}
            >
              <BarChart
                label={`Killed: ${[0, 1, 2]
                  .map((i) => ms(worst(chaos.killed, i as 0 | 1 | 2)))
                  .join(', ')} before, during and after. Paused: ${[0, 1, 2]
                  .map((i) => ms(worst(chaos.paused, i as 0 | 1 | 2)))
                  .join(', ')}.`}
                rows={(['Before', 'During', 'After'] as const).map((label, i) => ({
                  label,
                  values: [
                    worst(chaos.killed, i as 0 | 1 | 2),
                    worst(chaos.paused, i as 0 | 1 | 2),
                  ],
                }))}
                series={[
                  { name: 'Redis killed', color: SERIES_1 },
                  { name: 'Redis paused', color: SERIES_2 },
                ]}
                format={ms}
              />
            </Figure>

            <p>
              The two kinds of outage cost very differently. A dead Redis costs nothing: with the
              Redis client’s offline queue turned off, a check fails at once and the in-memory count
              answers, which is faster than a round trip. A frozen Redis costs the full 50 ms on
              every request, because nothing on the client side can tell a slow answer from no
              answer. The timeout is what bounds it <Record id="0018" />.
            </p>
            <p>
              Accuracy is the price. During an outage the limits are per server and approximate, and
              around each change a client can get about twice its limit in one window: the in-memory
              counts start full when Redis goes, and Redis comes back empty. After a kill, the
              servers were back on Redis in about {(Math.max(...recoveries) / 1000).toFixed(1)}{' '}
              seconds, the time the Redis client took to reconnect, and none fell back again{' '}
              <Record id="0010" />. The demo has a switch to take Redis down, so you can watch each
              server fall back to its own count.
            </p>
          </section>

          <section id="method" aria-labelledby="method-h">
            <h2 id="method-h">How the numbers were measured</h2>
            <p>
              Every benchmark ran on one laptop in Docker: k6 generating load, nginx doing round
              robin, three app instances, one Redis. End-to-end times on a setup like that are
              mostly noise from everything else sharing the machine, so the app times the limiter
              itself and reports it in a <code>Server-Timing</code> header. Each configuration ran
              three times, and every number here is a median. The results are for comparing
              algorithms with each other, not for capacity planning <Record id="0017" />.
            </p>
            <p>
              The analysis was written before any data existed, so it couldn’t be tuned to flatter a
              result. One fix came later, and it went the honest way: the sliding window log once
              read as 101 against a limit of 100 on a busy machine. The log was right; the
              measurement had given every request a fixed 2 ms of timing tolerance, which wasn’t
              enough. Each request now gets a tolerance from its own measured time, and no published
              number changed <Record id="0021" />. Every results folder records the machine, the
              versions, the commit and the exact command, so any chart here can be rebuilt.
            </p>
            <p>
              The tests are measured too. Coverage only shows that code ran, so mutation testing
              made about 1,800 small changes to the code and the Lua, one at a time, such as{' '}
              <code>&lt;</code> to <code>&lt;=</code>, and checked that a test failed for each.
              Every change no test noticed got a new test, or a written reason it can’t change
              behaviour <Record id="0033" />. Property tests generate random histories of requests
              and check seven rules hold for every algorithm, shrinking any failure to the shortest
              history that shows it <Record id="0034" />. And the demo runs the exact Lua scripts
              the package ships, in WebAssembly, against a stand-in for Redis that a test compares
              with the real thing on generated histories <Record id="0024" />.
            </p>
          </section>

          <section id="more" aria-labelledby="more-h">
            <h2 id="more-h">Other decisions</h2>
            <p>Smaller choices, each with its own record:</p>
            <ul className="wu-list wu-more">
              <li>
                <Record id="0012">Headers</Record>: <code>RateLimit-Limit</code>,{' '}
                <code>-Remaining</code> and <code>-Reset</code> in whole seconds, rounded up so a
                client that waits as told is never early. What the reset time means differs between
                allowed and refused requests <Record id="0003" />.
              </li>
              <li>
                <Record id="0026">Who the client is</Record>: the default never reads an API key,
                since a made-up key would be a new client with a full limit. An app that limits by
                key checks it first and passes the account, which replaced hashing whatever key
                arrived <Record id="0002" />.
              </li>
              <li>
                <Record id="0030">Matching paths</Record>: rules match paths the way Express routes
                them and the way a decoding handler reads them, so encoded or <code>..</code> paths
                can’t slip past a rule <Record id="0027" /> <Record id="0011" />.
              </li>
              <li>
                <Record id="0029">IP addresses</Record>: IPv6 clients are grouped by /64, IPv6 that
                carries IPv4 counts as IPv4, and a forged value that isn’t an address is never a
                client <Record id="0020" />.
              </li>
              <li>
                <Record id="0028">Key prefixes</Record>: two limiters sharing one Redis get their
                own keys.
              </li>
              <li>
                <Record id="0015">Rules files</Record> in YAML or JSON, with unknown fields rejected
                at startup, in code too <Record id="0032" />.
              </li>
              <li>
                <Record id="0025">Publishing</Record> happens only from CI, with npm’s trusted
                publishing and provenance, so a release can be traced to the commit it came from.
              </li>
            </ul>
            <p>
              All {Object.keys(RECORDS).length} records are in the{' '}
              <a
                href={`${REPO_URL}/blob/main/docs/decisions/README.md`}
                target="_blank"
                rel="noreferrer"
              >
                decision index
              </a>
              , and the code is on{' '}
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                GitHub
              </a>
              .
            </p>
          </section>

          <footer className="wu-foot">
            <a className="wu-cta" href="../">
              Open the live demo
            </a>
            <code className="wu-install">npm install @kylewillett/rate-limiter</code>
          </footer>
        </article>
      </main>
    </div>
  );
}

function EdgesTimeline({ data }: { data: WriteupData }) {
  const { edges } = data;
  const shown = ['fixed-window', 'sliding-window-log'] as const;
  const series = shown.map((a, i) => {
    const s = edges.series.find((e) => e.algorithm === a);
    return {
      name: ALGORITHM_COPY[a].name,
      color: i === 0 ? SERIES_1 : SERIES_2,
      points: (s?.points ?? []).map(([t, n]) => [t / 1000, n] as const),
    };
  });
  const end = Math.ceil(Math.max(...series.flatMap((s) => s.points.map(([t]) => t))) / 10) * 10;
  return (
    <Figure
      title="Requests allowed in the last 10 seconds, over time"
      description={`The busiest client in the median run of the edges test, ${lower('fixed-window')} against ${lower('sliding-window-log')}.`}
      source={
        <>
          Source: the edges benchmark’s chart data, <Record id="0008" />.
        </>
      }
      table={{
        columns: ['Algorithm', 'Allowed requests', 'Most in one window'],
        rows: series.map((s) => [
          s.name,
          whole(s.points.length),
          whole(Math.max(...s.points.map(([, n]) => n))),
        ]),
      }}
    >
      <LineChart
        label={`Over about ${String(end)} seconds, the fixed window's count spikes to ${String(
          Math.max(...(series[0]?.points.map(([, n]) => n) ?? [0])),
        )} at each window edge, while the sliding window log stays at or under ${String(edges.limit)}.`}
        series={series}
        x={{
          min: 0,
          max: end,
          ticks: Array.from({ length: end / 20 + 1 }, (_, i) => i * 20),
          format: (t) => `${String(Math.round(t))} s`,
        }}
        y={{ min: 0, max: 220, ticks: [0, 50, 100, 150, 200], format: whole }}
        reference={{ value: edges.limit, label: `Limit ${String(edges.limit)}` }}
        xTitle="Time"
        dots
      />
    </Figure>
  );
}
