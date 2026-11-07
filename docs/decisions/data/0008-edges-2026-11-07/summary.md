## edges

Rule: 100 per 10000 ms per client. Each cell is the median of 3 runs. Method: [0017](../../0017-how-the-benchmarks-measure.md).

| Algorithm | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- | --- |
| token-bucket | 0.14 | 1.29 | 0.37 | 3.16 | 1050 | 154 (1.54× limit) | 0.0% |
| leaky-bucket | 0.15 | 1.34 | 0.37 | 3.20 | 1050 | 54 (0.54× limit) | 70.3% |
| fixed-window | 0.13 | 1.36 | 0.37 | 3.18 | 1049 | 200 (2.00× limit) | 0.0% |
| sliding-window-log | 0.15 | 1.40 | 0.38 | 3.32 | 1050 | 100 (1.00× limit) | 0.0% |
| sliding-window-counter | 0.14 | 1.32 | 0.37 | 3.17 | 1049 | 105 (1.05× limit) | 14.6% |
