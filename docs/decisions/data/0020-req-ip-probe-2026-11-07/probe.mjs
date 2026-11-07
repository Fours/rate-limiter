// Milestone 4, T5: what req.ip looks like in Express 5 for IPv4, IPv6 and IPv4-mapped clients,
// directly and through trust proxy. Run from anywhere: node docs/decisions/data/0020-req-ip-probe-2026-11-07/probe.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const express = require('express');
console.log('express', require('express/package.json').version, 'node', process.version);

async function serve(trust, host) {
  const app = express();
  if (trust !== undefined) app.set('trust proxy', trust);
  app.get('/', (req, res) => res.json({ ip: req.ip, ips: req.ips, remote: req.socket.remoteAddress }));
  const server = await new Promise((r) => { const s = app.listen(0, host, () => r(s)); });
  return server;
}
function get(port, host, headers = {}, localAddress) {
  return new Promise((resolve, reject) => {
    http.get({ host, port, path: '/', headers, ...(localAddress ? { localAddress } : {}) }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(JSON.parse(s)));
    }).on('error', reject);
  });
}
const cases = [
  ['listen ::, IPv4 client', undefined, '::', '127.0.0.1', {}],
  ['listen ::, IPv6 client', undefined, '::', '::1', {}],
  ['listen 0.0.0.0, IPv4 client', undefined, '0.0.0.0', '127.0.0.1', {}],
  ['listen 127.0.0.1 (IPv4 only)', undefined, '127.0.0.1', '127.0.0.1', {}],
];
const xff = [
  '2001:db8:1:2:3:4:5:6', '2001:DB8:0001:0002::6', '[2001:db8::1]', 'fe80::1%eth0', '::ffff:203.0.113.7', '203.0.113.7', '2001:db8::1, 198.51.100.2', '::ffff:cb00:7107',
];
for (const [label, trust, listenHost, clientHost, headers] of cases) {
  const s = await serve(trust, listenHost);
  try { console.log(label.padEnd(36), JSON.stringify(await get(s.address().port, clientHost, headers))); }
  catch (e) { console.log(label.padEnd(36), 'error', e.code); }
  s.close();
}
for (const trust of [true, 1, 'loopback']) {
  const s = await serve(trust, '::');
  for (const value of xff) {
    console.log(`trust ${JSON.stringify(trust)}, XFF ${value}`.padEnd(56), JSON.stringify(await get(s.address().port, '127.0.0.1', { 'x-forwarded-for': value })));
  }
  s.close();
}
