# 0029. IPv6 that carries IPv4 counts as IPv4, and a value that isn't an IP is never a client ID

- **Status:** Accepted. Supersedes [0020](0020-ipv6-by-64.md).
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

[0020](0020-ipv6-by-64.md) groups IPv6 clients by /64 and reads an IPv4-mapped address (`::ffff:1.2.3.4`) as the IPv4 address it carries. The 1.0 security review found two gaps in it.

**Other IPv6 forms carry IPv4 too.** Behind a NAT64 or 464XLAT translator, or in an IPv6-only data centre (SIIT-DC), an IPv4 client arrives as `64:ff9b::1.2.3.4`. Under 0020 that's IPv6, so every IPv4 client behind the translator shared `ip_64:ff9b::/64`, and one client could use up the limit for all of them. The probe, with `trust proxy` and ten clients `64:ff9b::198.51.100.1` to `.10` against a limit of 3: 3 of 10 allowed in all. The translated form `::ffff:0:1.2.3.4` and the old IPv4-compatible form `::1.2.3.4` collapsed to `ip_::/64` in the same way.

**0020 kept a value that isn't an IP as it is.** `req.ip` can only be something other than an IP when Express takes it from `X-Forwarded-For`, which means a client wrote it. A client that can reach the app without the proxy could send `garbage-1`, `garbage-2` and so on, and each was a new client with a full limit, up to the header size limit of about 16 KB per key. The probe: rotating values with `trust proxy` set to 1, 10 of 10 allowed.

## Decision

- **IPv6 that carries an IPv4 address is that IPv4 address,** for these prefixes, each of which puts it in the last 32 bits:
  - `::ffff:0:0/96`, IPv4-mapped, as in 0020
  - `::ffff:0:0:0/96`, translated (RFC 2765)
  - `64:ff9b::/96`, the well-known NAT64 prefix (RFC 6052)
  - `::/96`, IPv4-compatible (deprecated), except `::` and `::1`, whose third-last group is 0
- **A `req.ip` that isn't an IP gives way to the connection's own address,** `req.socket.remoteAddress`, normalised the same way. If that isn't an IP either, the client is `anon`. A client's raw value never becomes its ID.
- Everything else in 0020 holds: IPv4 as it is, other IPv6 by /64 in RFC 5952 form, brackets and zones dropped.
- The README says that a client that can reach the app without the proxy can forge `X-Forwarded-For` with any `trust proxy` setting, not only `true`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Also read network-specific NAT64 prefixes, such as `64:ff9b:1::/48` | Any operator can choose its own prefix, so the limiter can't tell one from a real IPv6 network. An app behind one passes its own `identify`. |
| Put values that aren't IPs in one shared bucket | Everyone who sent one would share a limit, but so might a legitimate proxy that sends something odd. The connection's address is the actual sender when the app is reached directly, which is the only way a forged value gets in. |
| Hash values that aren't IPs | Shorter keys, but still a new client per value |
| Reject requests whose `req.ip` isn't an IP | It isn't the limiter's place to refuse a request |

## Evidence

- The two probes above, from the review.
- `test/identify.test.ts`: each of the four prefixes gives the IPv4 ID, written as dotted or hex; two clients behind one NAT64 translator get different IDs; `::`, `::1` and `::ffff` stay IPv6; IPv4 tails under other prefixes, including `64:ff9b:1::`, stay IPv6; a value that isn't an IP, including one 10,000 characters long, gives the connection's ID; and with neither an IP, `anon`.
- `test/identify.express.test.ts`: in a real Express app with `trust proxy`, forged `X-Forwarded-For` values that aren't IPs get the connection's ID, and forwarded NAT64 clients get their own IPv4 IDs.
- Break checks: dropping the NAT64 prefix fails 4 tests, and going back to the raw value fails 3.
- The rest of 0020's evidence stands: its probe and tests are unchanged and still pass.

## Consequences

- An IPv4 client keeps one ID whichever of these forms it arrives in.
- `IdentifiableRequest` gains an optional `socket`, which an Express `Request` already has.
- Clients that arrived in these forms before get new keys and start once with a full limit. No version was published.
- A misconfigured `trust proxy` still lets a directly connected client forge a valid IP each time. Only the setting can fix that, so the README's warning now covers every setting.
