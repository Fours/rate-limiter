# 0029. IPv6 that carries IPv4 counts as IPv4

- **Status:** Accepted. Supersedes [0020](0020-ipv6-by-64.md).
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

[0020](0020-ipv6-by-64.md) groups IPv6 clients by /64 and reads an IPv4-mapped address (`::ffff:1.2.3.4`) as the IPv4 address it carries. The 1.0 security review found that other IPv6 forms carry IPv4 too.

Behind a NAT64 or 464XLAT translator, or in an IPv6-only data centre (SIIT-DC), an IPv4 client arrives as `64:ff9b::1.2.3.4`. Under 0020 that's IPv6, so every IPv4 client behind the translator shared `ip_64:ff9b::/64`, and one client could use up the limit for all of them. The probe, with `trust proxy` and ten clients `64:ff9b::198.51.100.1` to `.10` against a limit of 3: 3 of 10 allowed in all. The translated form `::ffff:0:1.2.3.4` and the old IPv4-compatible form `::1.2.3.4` collapsed to `ip_::/64` in the same way.

## Decision

- **IPv6 that carries an IPv4 address is that IPv4 address,** for these prefixes, each of which puts it in the last 32 bits:
  - `::ffff:0:0/96`, IPv4-mapped, as in 0020
  - `::ffff:0:0:0/96`, translated (RFC 2765)
  - `64:ff9b::/96`, the well-known NAT64 prefix (RFC 6052)
  - `::/96`, IPv4-compatible (deprecated), except `::` and `::1`, whose third-last group is 0
- Everything else in 0020 holds: IPv4 as it is, other IPv6 by /64 in RFC 5952 form, brackets and zones dropped.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Also read network-specific NAT64 prefixes, such as `64:ff9b:1::/48` | Any operator can choose its own prefix, so the limiter can't tell one from a real IPv6 network. An app behind one passes its own `identify`. |

## Evidence

- The probe above, from the review.
- `test/identify.test.ts`: each of the four prefixes gives the IPv4 ID, written as dotted or hex; two clients behind one NAT64 translator get different IDs; `::`, `::1` and `::ffff` stay IPv6; and IPv4 tails under other prefixes, including `64:ff9b:1::`, stay IPv6.
- `test/identify.express.test.ts`: in a real Express app with `trust proxy`, forwarded NAT64 clients get their own IPv4 IDs.
- Break check: dropping the NAT64 prefix fails 4 tests.
- The rest of 0020's evidence stands: its probe and tests are unchanged and still pass.

## Consequences

- An IPv4 client keeps one ID whichever of these forms it arrives in.
- Clients that arrived in these forms before get new keys and start once with a full limit. No version was published.
