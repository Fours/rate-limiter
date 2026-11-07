import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildKey, defaultIdentify, type IdentifiableRequest } from '../src/identify.js';

const apiKey = 'sk_test_4f9c2e7a1b';
// Computed outside Node: printf '%s' 'sk_test_4f9c2e7a1b' | shasum -a 256 | cut -c1-16
const apiKeyId = 'key_91f77e657ceb317b';

function req(parts: {
  key?: string | string[];
  user?: unknown;
  ip?: string | undefined;
}): IdentifiableRequest {
  return { headers: { 'x-api-key': parts.key }, ip: parts.ip, user: parts.user };
}

describe('defaultIdentify', () => {
  describe('precedence', () => {
    it('uses the API key over a user and an IP', () => {
      expect(defaultIdentify(req({ key: apiKey, user: { id: 'u1' }, ip: '10.0.0.1' }))).toBe(
        apiKeyId,
      );
    });

    it('uses the user ID over an IP', () => {
      expect(defaultIdentify(req({ user: { id: 'u1' }, ip: '10.0.0.1' }))).toBe('user_u1');
    });

    it('uses the IP when there is no key or user', () => {
      expect(defaultIdentify(req({ ip: '10.0.0.1' }))).toBe('ip_10.0.0.1');
    });

    it('falls back to anon when nothing is present', () => {
      expect(defaultIdentify(req({}))).toBe('anon');
    });
  });

  describe('empty or malformed values count as absent', () => {
    it('skips an empty API key', () => {
      expect(defaultIdentify(req({ key: '', ip: '10.0.0.1' }))).toBe('ip_10.0.0.1');
    });

    it('skips a header that is not a single string', () => {
      expect(defaultIdentify(req({ key: ['a', 'b'], ip: '10.0.0.1' }))).toBe('ip_10.0.0.1');
    });

    it.each([
      ['null user', null],
      ['a string user', 'u1'],
      ['a user without an id', { name: 'x' }],
      ['an empty string id', { id: '' }],
      ['a NaN id', { id: Number.NaN }],
      ['an object id', { id: { nested: 1 } }],
    ])('skips %s', (_label, user) => {
      expect(defaultIdentify(req({ user, ip: '10.0.0.1' }))).toBe('ip_10.0.0.1');
    });

    it('skips an empty IP', () => {
      expect(defaultIdentify(req({ ip: '' }))).toBe('anon');
    });
  });

  it('accepts a numeric user ID', () => {
    expect(defaultIdentify(req({ user: { id: 42 } }))).toBe('user_42');
  });

  describe('IPs (decision 0020)', () => {
    const id = (ip: string) => defaultIdentify(req({ ip }));

    it('groups IPv6 clients by /64: one ID inside a /64, different IDs across them', () => {
      expect(id('2001:db8:1:2:aaaa::1')).toBe('ip_2001:db8:1:2::/64');
      expect(id('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('ip_2001:db8:1:2::/64');
      expect(id('2001:db8:1:3::1')).toBe('ip_2001:db8:1:3::/64');
      // The /64 boundary: bit 64 is in the fourth group, so these differ.
      expect(id('2001:db8:1:2:ffff::1')).not.toBe(id('2001:db8:1:3::1'));
      expect(id('2001:db8::1')).not.toBe(id('2001:db9::1'));
    });

    it('gives one ID for every way of writing an address', () => {
      const forms = [
        '2001:db8:0:1::5',
        '2001:0db8:0000:0001:0000:0000:0000:0005',
        '2001:DB8:0:1:0:0:0:5',
        '2001:db8::1:0:0:0:5',
        '[2001:db8:0:1::5]',
        '2001:db8:0:1::5%eth0',
        '[2001:db8:0:1::5%eth0]',
      ];
      for (const form of forms) expect(id(form)).toBe('ip_2001:db8:0:1::/64');
    });

    it('writes the /64 in RFC 5952 form', () => {
      expect(id('::1')).toBe('ip_::/64');
      expect(id('fe80::1%en0')).toBe('ip_fe80::/64');
      expect(id('2001:db8:0:0:1::')).toBe('ip_2001:db8::/64');
      expect(id('1:0:2:0::')).toBe('ip_1:0:2::/64');
      // An IPv4 tail on a non-mapped address is just more IPv6 bits.
      expect(id('64:ff9b::198.51.100.7')).toBe('ip_64:ff9b::/64');
    });

    it('keeps IPv4 as today, and gives IPv4-mapped addresses the same ID', () => {
      expect(id('203.0.113.7')).toBe('ip_203.0.113.7');
      expect(id('::ffff:203.0.113.7')).toBe('ip_203.0.113.7');
      expect(id('::FFFF:203.0.113.7')).toBe('ip_203.0.113.7');
      expect(id('::ffff:cb00:7107')).toBe('ip_203.0.113.7');
      expect(id('0:0:0:0:0:ffff:cb00:7107')).toBe('ip_203.0.113.7');
      // A zone touches only the last group, which is outside any /64, except in a mapped address.
      expect(id('::ffff:203.0.113.7%eth0')).toBe('ip_203.0.113.7');
    });

    it('keeps a value that is not an IP as it is', () => {
      expect(id('unknown')).toBe('ip_unknown');
      expect(id('01.2.3.4')).toBe('ip_01.2.3.4');
      expect(id('2001:db8::1::2')).toBe('ip_2001:db8::1::2');
    });
  });

  describe('API key hashing', () => {
    it('never puts the raw key, or any 6-character piece of it, in the output', () => {
      const secret = 'sk_live_Zq8vR3mK0pXw7Jt2Ly5Nc9Bd';
      const id = defaultIdentify(req({ key: secret }));
      expect(id).toMatch(/^key_[0-9a-f]{16}$/);
      for (let i = 0; i + 6 <= secret.length; i++) {
        expect(id).not.toContain(secret.slice(i, i + 6));
      }
    });

    it('is stable: pinned to sha256, first 16 hex chars', () => {
      expect(defaultIdentify(req({ key: apiKey }))).toBe(apiKeyId);
      const expected = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
      expect(apiKeyId).toBe(`key_${expected}`);
    });

    it('gives the same ID every time and different IDs for different keys', () => {
      expect(defaultIdentify(req({ key: 'k1' }))).toBe(defaultIdentify(req({ key: 'k1' })));
      expect(defaultIdentify(req({ key: 'k1' }))).not.toBe(defaultIdentify(req({ key: 'k2' })));
    });
  });
});

describe('buildKey', () => {
  it('formats rl:{rule.id}:{clientId}', () => {
    expect(buildKey({ id: 'orders:free' }, 'key_3f2a9c1e5b7d4e8a')).toBe(
      'rl:orders:free:key_3f2a9c1e5b7d4e8a',
    );
  });

  it('passes IPv6 client IDs through unchanged', () => {
    expect(buildKey({ id: 'global' }, 'ip_::1')).toBe('rl:global:ip_::1');
  });
});
