## edges

Rule: 2 per 1000 ms per client. Each cell is the median of 1 or 3 runs. Method: [0017](../../0017-how-the-benchmarks-measure.md).

| Algorithm | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | – | – | 6.00 | 7.00 | 3 | 3 (1.50× limit) | 0.0% |
| fixed-window | 1.00 | 3.00 | 21.00 | 40.00 | 3 | 3 (1.50× limit) | 0.0% |
