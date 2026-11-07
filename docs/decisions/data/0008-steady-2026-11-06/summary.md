## steady

Rule: 100 per 60000 ms per client. Each cell is the median of 3 runs. Method: [0017](../../0017-how-the-benchmarks-measure.md).

| Algorithm | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | – | – | 0.57 | 1.49 | 501 | 47 (0.47× limit) | 0.0% |
| token-bucket | 0.18 | 0.73 | 0.56 | 1.87 | 501 | 51 (0.51× limit) | 0.0% |
| leaky-bucket | 0.18 | 0.72 | 0.54 | 1.82 | 501 | 35 (0.35× limit) | 23.1% |
| fixed-window | 0.17 | 0.69 | 0.53 | 1.83 | 501 | 49 (0.49× limit) | 0.0% |
| sliding-window-log | 0.19 | 0.75 | 0.57 | 1.92 | 501 | 51 (0.51× limit) | 0.0% |
| sliding-window-counter | 0.18 | 0.73 | 0.56 | 1.84 | 501 | 47 (0.47× limit) | 0.0% |
