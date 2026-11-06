## Redis memory per key, in bytes

Redis 7.4.12. Each cell: `MEMORY USAGE` after `limit` checks on one 35-byte key, and its encoding.

| Algorithm | 10 per minute | 100 per minute | 127 per minute | 128 per minute | 1,000 per minute |
| --- | --- | --- | --- | --- | --- |
| token-bucket | 160 (listpack) | 160 (listpack) | 160 (listpack) | 160 (listpack) | 160 (listpack) |
| leaky-bucket | 176 (listpack) | 176 (listpack) | 176 (listpack) | 176 (listpack) | 176 (listpack) |
| fixed-window | 176 (listpack) | 176 (listpack) | 176 (listpack) | 176 (listpack) | 176 (listpack) |
| sliding-window-log | 400 (listpack) | 3,152 (listpack) | 4,176 (listpack) | 15,328 (skiplist) | 102,944 (skiplist) |
| sliding-window-counter | 192 (listpack) | 192 (listpack) | 192 (listpack) | 192 (listpack) | 192 (listpack) |
