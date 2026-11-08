// Runs the same random request sequences through the real Redis (test Redis, :6390) and through
// wasmoon + FakeRedis, and compares every reply, the stored state after each step, and the
// PEXPIRE each script set. Uses the scripts' test-only time override (ARGV[3]) so both see the
// same time. Never flushes: every key is unique to this run and deleted at the end.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { FakeRedis, createRunner } from './shim.mjs';

const repo = '/Users/kylewillett/Documents/Dev/rate-limiter';
const Redis = createRequire(`${repo}/package.json`)('ioredis').default;
const dir = `${repo}/src/algorithms/redis`;
const prelude = readFileSync(`${dir}/prelude.lua`, 'utf8');
const algs = ['token-bucket', 'leaky-bucket', 'fixed-window', 'sliding-window-log', 'sliding-window-counter'];
const src = Object.fromEntries(algs.map((a) => [a, `${prelude}\n${readFileSync(`${dir}/${a}.lua`, 'utf8')}`]));

const scenarios = Number(process.argv[2] ?? 40);
const steps = Number(process.argv[3] ?? 60);

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const randInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const real = new Redis('redis://localhost:6390');
let now = 0;
const fake = new FakeRedis(() => now);
fake.expiry = false; // the real side PERSISTs too, so neither expires mid-sequence
const runner = await createRunner(fake);

async function realDump(key) {
  const type = await real.type(key);
  if (type === 'none') return { type };
  if (type === 'hash') {
    const h = await real.hgetall(key);
    return { type, value: Object.fromEntries(Object.entries(h).sort()) };
  }
  return { type, value: await real.zrange(key, 0, -1, 'WITHSCORES') };
}

const run = `rl-probe:${Date.now()}`;
const keys = [];
let checks = 0;
const mismatches = [];
const ttlOffByOne = { n: 0 };

for (let s = 0; s < scenarios; s++) {
  for (const alg of algs) {
    const key = `${run}:${alg}:${s}`;
    keys.push(key);
    let rule = { limit: pick([1, 2, 3, 5, 7, 10, 20, 100]), window: pick([1, 7, 100, 333, 1000, 1500, 60000]) };
    now = 1_700_000_000_000 + randInt(0, 10_000_000);
    for (let i = 0; i < steps; i++) {
      const r = rnd();
      if (r < 0.25) now += 0;
      else if (r < 0.5) now += randInt(1, 3);
      else if (r < 0.85) now += randInt(0, Math.ceil(rule.window / rule.limit) * 2);
      else if (r < 0.88) now += randInt(0, rule.window * 2);
      else if (r < 0.95) now += pick([rule.window, rule.window - 1, rule.window + 1, Math.ceil(rule.window / rule.limit)]); // exact edges
      else now -= randInt(1, 50); // a clock that steps back
      let a = alg;
      const t = rnd();
      if (t < 0.04) rule = { limit: pick([1, 3, 10, 50]), window: pick([7, 1000, 2500]) };
      else if (t < 0.07) a = pick(algs); // another algorithm on the same key (0016)
      const argv = [String(rule.limit), String(rule.window), String(now)];

      const [[e1, got], [e2, pttl]] = await real
        .multi()
        .eval(src[a], 1, key, ...argv)
        .pttl(key)
        .persist(key)
        .exec();
      let want;
      try {
        want = runner.run(src[a], [key], argv);
      } catch (err) {
        want = `error: ${err.message}`;
      }
      const realReply = e1 ? `error: ${e1.message}` : got;
      const fakeTtl = fake.lastPexpire.get(key);
      fake.lastPexpire.delete(key);
      const [rd, fd] = [await realDump(key), fake.dump(key)];
      checks++;
      const ctx = { alg: a, key, step: i, rule, now };
      if (JSON.stringify(realReply) !== JSON.stringify(want)) mismatches.push({ ...ctx, what: 'reply', real: realReply, fake: want });
      if (JSON.stringify(rd) !== JSON.stringify(fd)) mismatches.push({ ...ctx, what: 'state', real: rd, fake: fd });
      // PTTL is read a moment after the script ran, so allow it to be 1 ms lower.
      const realTtl = pttl;
      if (fakeTtl !== undefined && fakeTtl > 0) {
        if (realTtl === fakeTtl - 1) ttlOffByOne.n++;
        else if (realTtl !== fakeTtl) mismatches.push({ ...ctx, what: 'ttl', real: realTtl, fake: fakeTtl });
      } else if (fakeTtl !== undefined && realTtl !== -2) {
        mismatches.push({ ...ctx, what: 'ttl<=0', real: realTtl, fake: fakeTtl });
      }
    }
  }
}

for (let i = 0; i < keys.length; i += 500) await real.del(...keys.slice(i, i + 500));
await real.quit();

console.log(`${checks} checks, ${mismatches.length} mismatches, ${ttlOffByOne.n} TTLs 1 ms lower on Redis`);
for (const m of mismatches.slice(0, 10)) console.log(JSON.stringify(m));
