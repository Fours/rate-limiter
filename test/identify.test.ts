import { describe, expect, it } from 'vitest';
import { buildKey, defaultIdentify, type IdentifiableRequest } from '../src/identify.js';

function req(parts: { user?: unknown; ip?: string | undefined }): IdentifiableRequest {
  return { ip: parts.ip, user: parts.user };
}

describe('defaultIdentify', () => {
  describe('precedence', () => {
    it('uses the user ID over an IP', () => {
      expect(defaultIdentify(req({ user: { id: 'u1' }, ip: '10.0.0.1' }))).toBe('user_u1');
    });

    it('uses the IP when there is no user', () => {
      expect(defaultIdentify(req({ ip: '10.0.0.1' }))).toBe('ip_10.0.0.1');
    });

    it('falls back to anon when nothing is present', () => {
      expect(defaultIdentify(req({}))).toBe('anon');
    });
  });

  describe('empty or malformed values count as absent', () => {
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
      // An IPv4 tail outside the prefixes that carry IPv4 is just more IPv6 bits.
      expect(id('2001:db8::198.51.100.7')).toBe('ip_2001:db8::/64');
      expect(id('64:ff9b:1::198.51.100.7')).toBe('ip_64:ff9b:1::/64');
    });

    it.each([
      ['NAT64, well-known prefix', '64:ff9b::198.51.100.7'],
      ['NAT64 in hex', '64:ff9b::c633:6407'],
      ['translated (RFC 2765)', '::ffff:0:198.51.100.7'],
      ['IPv4-compatible', '::198.51.100.7'],
    ])('gives an address that carries IPv4, %s, its IPv4 ID (0029)', (_label, ip) => {
      expect(id(ip)).toBe('ip_198.51.100.7');
    });

    it('keeps two IPv4 clients behind one NAT64 translator apart (0029)', () => {
      expect(id('64:ff9b::198.51.100.1')).not.toBe(id('64:ff9b::198.51.100.2'));
    });

    it('leaves :: and ::1 as IPv6, not as 0.0.0.0 and 0.0.0.1', () => {
      expect(id('::')).toBe('ip_::/64');
      expect(id('::1')).toBe('ip_::/64');
      expect(id('::ffff')).toBe('ip_::/64');
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

  describe('API keys (decision 0026)', () => {
    it('never reads an x-api-key header, so a made-up key is not a new client', () => {
      const withKey = (key: string) =>
        defaultIdentify({ headers: { 'x-api-key': key }, ip: '10.0.0.1' } as IdentifiableRequest);
      expect(withKey('made-up-1')).toBe('ip_10.0.0.1');
      expect(withKey('made-up-2')).toBe('ip_10.0.0.1');
    });
  });
});

describe('buildKey', () => {
  it('formats rl:{rule.id}:{clientId}', () => {
    expect(buildKey({ id: 'orders:free' }, 'key_3f2a9c1e5b7d4e8a')).toBe(
      'rl:orders:free:key_3f2a9c1e5b7d4e8a',
    );
  });

  it('starts with the given prefix instead of rl (0028)', () => {
    expect(buildKey({ id: 'global' }, 'ip_10.0.0.1', 'preauth')).toBe('preauth:global:ip_10.0.0.1');
  });

  it('passes IPv6 client IDs through unchanged', () => {
    expect(buildKey({ id: 'global' }, 'ip_::1')).toBe('rl:global:ip_::1');
  });
});
