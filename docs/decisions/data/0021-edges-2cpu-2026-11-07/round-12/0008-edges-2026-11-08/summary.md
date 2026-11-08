## edges

Rule: 100 per 10000 ms per client. Each cell is the median of 1 runs. Method: [0017](../../0017-how-the-benchmarks-measure.md).

| Algorithm | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sliding-window-log | 0.30 | 3.61 | 0.86 | 7.57 | 1045 | 100 (1.00× limit) | 0.0% |

### Redis operations

From `INFO commandstats` before and after each run, leaving out the healthcheck's `PING` and the runner's own `INFO`. A round trip is an `EVAL` or `EVALSHA` from an app; commands per request also counts what the scripts run inside Redis. Median of runs.

| Algorithm | Round trips per request | Round trips per second | Commands per request | Commands |
| --- | --- | --- | --- | --- |
| sliding-window-log | 1.001 | 186 | 11.00 | `eval`, `evalsha`, `pexpire`, `time`, `type`, `zadd`, `zcount`, `zrange`, `zrangebyscore`, `zremrangebyscore`, `zscore` |
