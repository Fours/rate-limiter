# What `req.ip` looks like in Express 5

Milestone 4, T5. The form `req.ip` takes for IPv4, IPv6 and IPv4-mapped clients, connecting directly and through `trust proxy` (`true`, `1` and `'loopback'`), before designing `defaultIdentify`'s grouping around it.

## Setup

- Apple M5 Pro, macOS, Express 5.3.0 and Node from `setup.json`
- Command: `node docs/decisions/data/0020-req-ip-probe-2026-11-07/probe.mjs`, after `npm install`. No Docker needed. It listens on random loopback ports.

## Output

Each line is the server's `req.ip`, `req.ips` and the socket's own address.

```text
express 5.3.0 node v25.8.2
listen ::, IPv4 client               {"ip":"::ffff:127.0.0.1","ips":[],"remote":"::ffff:127.0.0.1"}
listen ::, IPv6 client               {"ip":"::1","ips":[],"remote":"::1"}
listen 0.0.0.0, IPv4 client          {"ip":"127.0.0.1","ips":[],"remote":"127.0.0.1"}
listen 127.0.0.1 (IPv4 only)         {"ip":"127.0.0.1","ips":[],"remote":"127.0.0.1"}
trust true, XFF 2001:db8:1:2:3:4:5:6                     {"ip":"2001:db8:1:2:3:4:5:6","ips":["2001:db8:1:2:3:4:5:6"],"remote":"::ffff:127.0.0.1"}
trust true, XFF 2001:DB8:0001:0002::6                    {"ip":"2001:DB8:0001:0002::6","ips":["2001:DB8:0001:0002::6"],"remote":"::ffff:127.0.0.1"}
trust true, XFF [2001:db8::1]                            {"ip":"[2001:db8::1]","ips":["[2001:db8::1]"],"remote":"::ffff:127.0.0.1"}
trust true, XFF fe80::1%eth0                             {"ip":"fe80::1%eth0","ips":["fe80::1%eth0"],"remote":"::ffff:127.0.0.1"}
trust true, XFF ::ffff:203.0.113.7                       {"ip":"::ffff:203.0.113.7","ips":["::ffff:203.0.113.7"],"remote":"::ffff:127.0.0.1"}
trust true, XFF 203.0.113.7                              {"ip":"203.0.113.7","ips":["203.0.113.7"],"remote":"::ffff:127.0.0.1"}
trust true, XFF 2001:db8::1, 198.51.100.2                {"ip":"2001:db8::1","ips":["2001:db8::1","198.51.100.2"],"remote":"::ffff:127.0.0.1"}
trust true, XFF ::ffff:cb00:7107                         {"ip":"::ffff:cb00:7107","ips":["::ffff:cb00:7107"],"remote":"::ffff:127.0.0.1"}
trust 1, XFF 2001:db8:1:2:3:4:5:6                        {"ip":"2001:db8:1:2:3:4:5:6","ips":["2001:db8:1:2:3:4:5:6"],"remote":"::ffff:127.0.0.1"}
trust 1, XFF 2001:DB8:0001:0002::6                       {"ip":"2001:DB8:0001:0002::6","ips":["2001:DB8:0001:0002::6"],"remote":"::ffff:127.0.0.1"}
trust 1, XFF [2001:db8::1]                               {"ip":"[2001:db8::1]","ips":["[2001:db8::1]"],"remote":"::ffff:127.0.0.1"}
trust 1, XFF fe80::1%eth0                                {"ip":"fe80::1%eth0","ips":["fe80::1%eth0"],"remote":"::ffff:127.0.0.1"}
trust 1, XFF ::ffff:203.0.113.7                          {"ip":"::ffff:203.0.113.7","ips":["::ffff:203.0.113.7"],"remote":"::ffff:127.0.0.1"}
trust 1, XFF 203.0.113.7                                 {"ip":"203.0.113.7","ips":["203.0.113.7"],"remote":"::ffff:127.0.0.1"}
trust 1, XFF 2001:db8::1, 198.51.100.2                   {"ip":"198.51.100.2","ips":["198.51.100.2"],"remote":"::ffff:127.0.0.1"}
trust 1, XFF ::ffff:cb00:7107                            {"ip":"::ffff:cb00:7107","ips":["::ffff:cb00:7107"],"remote":"::ffff:127.0.0.1"}
trust "loopback", XFF 2001:db8:1:2:3:4:5:6               {"ip":"2001:db8:1:2:3:4:5:6","ips":["2001:db8:1:2:3:4:5:6"],"remote":"::ffff:127.0.0.1"}
trust "loopback", XFF 2001:DB8:0001:0002::6              {"ip":"2001:DB8:0001:0002::6","ips":["2001:DB8:0001:0002::6"],"remote":"::ffff:127.0.0.1"}
trust "loopback", XFF [2001:db8::1]                      {"ip":"[2001:db8::1]","ips":["[2001:db8::1]"],"remote":"::ffff:127.0.0.1"}
trust "loopback", XFF fe80::1%eth0                       {"ip":"fe80::1%eth0","ips":["fe80::1%eth0"],"remote":"::ffff:127.0.0.1"}
trust "loopback", XFF ::ffff:203.0.113.7                 {"ip":"::ffff:203.0.113.7","ips":["::ffff:203.0.113.7"],"remote":"::ffff:127.0.0.1"}
trust "loopback", XFF 203.0.113.7                        {"ip":"203.0.113.7","ips":["203.0.113.7"],"remote":"::ffff:127.0.0.1"}
trust "loopback", XFF 2001:db8::1, 198.51.100.2          {"ip":"198.51.100.2","ips":["198.51.100.2"],"remote":"::ffff:127.0.0.1"}
trust "loopback", XFF ::ffff:cb00:7107                   {"ip":"::ffff:cb00:7107","ips":["::ffff:cb00:7107"],"remote":"::ffff:127.0.0.1"}
```

## What it means for `defaultIdentify`

- **A dual-stack listener maps IPv4.** A server listening on `::`, Node's default when IPv6 is available, sees an IPv4 client as `::ffff:127.0.0.1`. Only an IPv4-only listener gives `127.0.0.1`. So until now the same client got `ip_::ffff:…` or `ip_…` depending on how the server listened.
- **`trust proxy` passes X-Forwarded-For through as sent.** Express doesn't normalise it: uppercase hex, leading zeros, `[brackets]`, a zone (`%eth0`) and both mapped forms (`::ffff:203.0.113.7` and `::ffff:cb00:7107`) all reach `req.ip` unchanged. With `trust proxy` set to `1` or `'loopback'`, the last untrusted hop is used, as documented.
- So `defaultIdentify` has to parse the address itself: strip brackets and zones, turn mapped addresses into IPv4, and write IPv6 in one canonical form before taking the /64.
