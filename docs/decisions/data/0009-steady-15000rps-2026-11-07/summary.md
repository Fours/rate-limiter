## steady

Rule: 100 per 60000 ms per client. Each cell is the median of 3 runs. Method: [0017](../../0017-how-the-benchmarks-measure.md).

| Algorithm | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | – | – | 0.23 | 1.38 | 15022 | 986 (9.86× limit) | 0.0% |
| token-bucket | 0.11 | 0.85 | 0.34 | 2.26 | 15021 | 199 (1.99× limit) | 0.0% |

### Redis operations

From `INFO commandstats` before and after each run, leaving out the healthcheck's `PING` and the runner's own `INFO`. A round trip is an `EVAL` or `EVALSHA` from an app; commands per request also counts what the scripts run inside Redis. Median of runs.

| Algorithm | Round trips per request | Round trips per second | Commands per request | Commands |
| --- | --- | --- | --- | --- |
| none | 0.000 | 0 | 0.00 | – |
| token-bucket | 1.000 | 14,989 | 7.00 | `eval`, `evalsha`, `hget`, `hmget`, `hset`, `pexpire`, `time`, `type` |
