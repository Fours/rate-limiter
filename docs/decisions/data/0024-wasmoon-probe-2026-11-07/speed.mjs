import { readFileSync } from 'node:fs';
import { FakeRedis, createRunner } from './shim.mjs';
const dir = '/Users/kylewillett/Documents/Dev/rate-limiter/src/algorithms/redis';
const prelude = readFileSync(`${dir}/prelude.lua`, 'utf8');
let now = 1_700_000_000_000;
const fake = new FakeRedis(() => now);
const runner = await createRunner(fake);
for (const a of ['token-bucket','leaky-bucket','fixed-window','sliding-window-log','sliding-window-counter']) {
  const src = `${prelude}\n${readFileSync(`${dir}/${a}.lua`, 'utf8')}`;
  // TIME path (no override) and simulated expiry
  const first = runner.run(src, [`k:${a}`], ['5', '1000', '']);
  now += 5000;
  const typeAfter = fake.dump(`k:${a}`).type;
  const n = 20000; const t0 = performance.now();
  for (let i = 0; i < n; i++) { now += 3; runner.run(src, [`k:${a}:${i % 50}`], ['10', '1000', '']); }
  const ms = performance.now() - t0;
  console.log(a.padEnd(24), 'first', JSON.stringify(first), 'after 5 s:', typeAfter, `${Math.round(n / ms * 1000)} checks/s, ${(ms / n * 1000).toFixed(0)} µs each`);
}
