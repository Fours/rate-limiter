import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { defaultIdentify } from '../src/identify.js';

// Runs defaultIdentify inside a real Express app, so the header and req.ip shapes it relies on
// are checked against Express and Node rather than assumed.
function app(trustProxy = false) {
  const a = express();
  a.set('trust proxy', trustProxy);
  a.get('/', (req, res) => {
    res.json({ id: defaultIdentify(req) });
  });
  return a;
}

async function idFor(test: request.Test): Promise<string> {
  const res = await test;
  return (res.body as { id: string }).id;
}

/** Supertest only sends one value per header, so this uses node:http to send two header lines. */
async function idWithRepeatedHeader(values: string[]): Promise<string> {
  const server = app().listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const req = httpRequest({
      port,
      host: '127.0.0.1',
      path: '/',
      headers: { 'x-api-key': values },
    });
    req.end();
    const [res] = (await once(req, 'response')) as [NodeJS.ReadableStream];
    let body = '';
    for await (const chunk of res) body += String(chunk);
    return (JSON.parse(body) as { id: string }).id;
  } finally {
    server.close();
  }
}

describe('defaultIdentify in Express', () => {
  it('hashes an x-api-key header, whatever its case', async () => {
    const id = await idFor(request(app()).get('/').set('X-API-Key', 'abc'));
    expect(id).toMatch(/^key_[0-9a-f]{16}$/);
    expect(await idFor(request(app()).get('/').set('x-api-key', 'abc'))).toBe(id);
  });

  it('treats a header sent twice as one stable key, since Node joins it', async () => {
    const id = await idWithRepeatedHeader(['a', 'b']);
    expect(id).toMatch(/^key_/);
    expect(await idWithRepeatedHeader(['a', 'b'])).toBe(id);
    expect(await idFor(request(app()).get('/').set('x-api-key', 'a, b'))).toBe(id);
  });

  it('falls back to the IP when the header is empty', async () => {
    expect(await idFor(request(app()).get('/').set('x-api-key', ''))).toMatch(/^ip_/);
  });

  it('ignores X-Forwarded-For unless trust proxy is set', async () => {
    const xff = { 'X-Forwarded-For': '203.0.113.7' };
    expect(await idFor(request(app(false)).get('/').set(xff))).not.toBe('ip_203.0.113.7');
    expect(await idFor(request(app(true)).get('/').set(xff))).toBe('ip_203.0.113.7');
  });
});

/**
 * What req.ip looks like for a direct client, and the ID it gets. Listens on `host` and connects
 * from `from`, with node:http so the addresses are exactly these.
 */
async function direct(host: string, from: string): Promise<{ ip: string; id: string }> {
  const a = express();
  a.get('/', (req, res) => {
    res.json({ ip: req.ip, id: defaultIdentify(req) });
  });
  const server = a.listen(0, host);
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const req = httpRequest({ port, host: from, path: '/' });
    req.end();
    const [res] = (await once(req, 'response')) as [NodeJS.ReadableStream];
    let body = '';
    for await (const chunk of res) body += String(chunk);
    return JSON.parse(body) as { ip: string; id: string };
  } finally {
    server.close();
  }
}

/** Whether this machine can listen and connect on IPv6 loopback (some CI containers can't). */
async function hasIpv6Loopback(): Promise<boolean> {
  try {
    await direct('::1', '::1');
    return true;
  } catch {
    return false;
  }
}

// Shapes found by 0020's probe on Express 5.3.0.
describe('IPs reaching defaultIdentify in Express (decision 0020)', () => {
  it('gives an IPv4 client of a dual-stack server, which arrives mapped, its IPv4 ID', async () => {
    const { ip, id } = await direct('::', '127.0.0.1');
    expect(ip).toBe('::ffff:127.0.0.1');
    expect(id).toBe('ip_127.0.0.1');
    // On an IPv4-only listener the same client arrives plain, and gets the same ID.
    expect(await direct('127.0.0.1', '127.0.0.1')).toEqual({ ip: '127.0.0.1', id: 'ip_127.0.0.1' });
  });

  it('gives a direct IPv6 client its /64', async (ctx) => {
    if (!(await hasIpv6Loopback())) ctx.skip();
    expect(await direct('::', '::1')).toEqual({ ip: '::1', id: 'ip_::/64' });
  });

  it('collapses the forms X-Forwarded-For passes through to one ID per /64, behind trust proxy', async () => {
    const forms = [
      '2001:db8:1:2:3:4:5:6',
      '2001:DB8:0001:0002::6',
      '[2001:db8:1:2::9]',
      '2001:db8:1:2::1%eth0',
    ];
    for (const xff of forms) {
      const test = request(app(true)).get('/').set('X-Forwarded-For', xff);
      expect(await idFor(test)).toBe('ip_2001:db8:1:2::/64');
    }
    const other = request(app(true)).get('/').set('X-Forwarded-For', '2001:db8:1:3::1');
    expect(await idFor(other)).toBe('ip_2001:db8:1:3::/64');
  });

  it('gives a forwarded IPv4-mapped address, in either form, the IPv4 ID', async () => {
    for (const xff of ['::ffff:203.0.113.7', '::ffff:cb00:7107', '203.0.113.7']) {
      const test = request(app(true)).get('/').set('X-Forwarded-For', xff);
      expect(await idFor(test)).toBe('ip_203.0.113.7');
    }
  });
});
