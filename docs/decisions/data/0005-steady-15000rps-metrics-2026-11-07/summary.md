## steady

Rule: 100 per 60000 ms per client. Each cell is the median of 3 runs. Method: [0017](../../0017-how-the-benchmarks-measure.md).

| Algorithm | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sliding-window-counter | 0.12 | 0.97 | 0.35 | 2.98 | 15013 | 167 (1.67× limit) | 0.0% |

### Redis operations

From `INFO commandstats` before and after each run, leaving out the healthcheck's `PING` and the runner's own `INFO`. A round trip is an `EVAL` or `EVALSHA` from an app; commands per request also counts what the scripts run inside Redis. Median of runs.

| Algorithm | Round trips per request | Round trips per second | Commands per request | Commands |
| --- | --- | --- | --- | --- |
| sliding-window-counter | 1.000 | 14,967 | 7.00 | `eval`, `evalsha`, `hget`, `hmget`, `hset`, `pexpire`, `time`, `type` |
