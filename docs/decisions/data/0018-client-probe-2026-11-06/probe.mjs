// Probe: what ioredis and node-redis do when Redis is killed, paused, or never there.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const { Redis } = require('ioredis');
const { createClient } = require('redis');

const PORT = 6391, NAME = 'rl-probe-redis';
const docker = (...a) => execFileSync('docker', a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timed(fn, cap = 3000) {
  const t = performance.now();
  let to;
  const r = await Promise.race([
    fn().then(() => 'ok', (e) => 'err: ' + String(e.message).slice(0, 70)),
    new Promise((res) => (to = setTimeout(() => res(`no answer in ${cap} ms`), cap))),
  ]);
  clearTimeout(to);
  return `${(performance.now() - t).toFixed(1)} ms ${r}`;
}

const configs = {
  'ioredis default': () => new Redis({ port: PORT }),
  'ioredis enableOfflineQueue:false': () => new Redis({ port: PORT, enableOfflineQueue: false }),
  'node-redis default': () => createClient({ url: `redis://127.0.0.1:${PORT}` }),
  'node-redis disableOfflineQueue': () => createClient({ url: `redis://127.0.0.1:${PORT}`, disableOfflineQueue: true }),
};

async function connect(name) {
  const c = configs[name]();
  c.on('error', () => {});
  if (name.startsWith('node-redis')) await c.connect();
  else await new Promise((r) => (c.status === 'ready' ? r() : c.once('ready', r)));
  return c;
}

async function probe(name, fault) {
  const c = await connect(name);
  const out = [`baseline ${await timed(() => c.ping())}`];
  docker(fault === 'kill' ? 'kill' : 'pause', NAME);
  await sleep(300);
  const pending = [];
  for (let i = 0; i < 3; i++) {
    const p = c.ping();
    pending.push(p.then(() => 'ok', (e) => 'err'));
    out.push(`during #${i + 1}: ${await timed(() => p, 2000)}`);
    await sleep(200);
  }
  const t = performance.now();
  docker(fault === 'kill' ? 'start' : 'unpause', NAME);
  let first;
  for (;;) {
    const r = await timed(() => c.ping(), 500);
    if (r.includes(' ok')) { first = performance.now() - t; break; }
    if (performance.now() - t > 20000) { first = 'never (20 s)'; break; }
    await sleep(50);
  }
  out.push(`back: first ok ${typeof first === 'number' ? first.toFixed(0) + ' ms' : first} after ${fault === 'kill' ? 'start' : 'unpause'}`);
  out.push(`commands sent during the fault ended: ${(await Promise.race([Promise.all(pending), sleep(3000).then(() => ['still pending'])])).join(', ')}`);
  name.startsWith('node-redis') ? await c.disconnect().catch(() => {}) : c.disconnect();
  console.log(`\n## ${name}, ${fault}\n` + out.map((l) => '  ' + l).join('\n'));
}

async function closedPort(name) {
  const c = name.startsWith('node-redis')
    ? createClient({ url: 'redis://127.0.0.1:1', disableOfflineQueue: name.includes('disable') })
    : new Redis({ port: 1, enableOfflineQueue: !name.includes('false'), lazyConnect: false });
  c.on('error', () => {});
  if (name.startsWith('node-redis')) c.connect().catch(() => {});
  await sleep(100);
  const r = [];
  for (let i = 0; i < 2; i++) r.push(await timed(() => c.ping(), 2000));
  name.startsWith('node-redis') ? c.destroy?.() : c.disconnect();
  console.log(`\n## ${name}, closed port\n  ${r.join('\n  ')}`);
}

try { docker('rm', '-f', NAME); } catch {}
docker('run', '-d', '--name', NAME, '-p', `${PORT}:6379`, 'redis:7.4.12-alpine', 'redis-server', '--save', '', '--appendonly', 'no');
await sleep(1000);
try {
  for (const name of Object.keys(configs)) {
    for (const fault of ['kill', 'pause']) {
      await probe(name, fault);
      await sleep(500);
    }
    await closedPort(name);
  }
} finally {
  docker('rm', '-f', NAME);
}
process.exit(0);
