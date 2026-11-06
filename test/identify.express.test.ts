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
