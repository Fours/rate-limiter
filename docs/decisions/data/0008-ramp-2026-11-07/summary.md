## ramp

Rule: 100 per 60000 ms per client. Each cell is the median of 3 runs. Method: [0017](../../0017-how-the-benchmarks-measure.md).

| Algorithm | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | – | – | – | – | 47721 | – | – |
| token-bucket | – | – | – | – | 39260 | – | – |
| leaky-bucket | – | – | – | – | 38804 | – | – |
| fixed-window | – | – | – | – | 40432 | – | – |
| sliding-window-log | – | – | – | – | 39977 | – | – |
| sliding-window-counter | – | – | – | – | 38620 | – | – |

### CPU at the peak second

Each container's highest CPU within a second either side of the busiest healthy second, as % of one core, median of runs. A single-threaded process tops out near 100%.

| Algorithm | app-1 | app-2 | app-3 | lb | redis |
| --- | --- | --- | --- | --- | --- |
| none | 101% | 102% | 102% | 96% | 1% |
| token-bucket | 107% | 107% | 107% | 88% | 60% |
| leaky-bucket | 106% | 105% | 106% | 88% | 62% |
| fixed-window | 108% | 109% | 109% | 90% | 63% |
| sliding-window-log | 109% | 107% | 108% | 91% | 78% |
| sliding-window-counter | 107% | 107% | 107% | 90% | 61% |
