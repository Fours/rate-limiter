## steady: spread across runs

Lowest–highest value of each metric across the runs that the summary takes the median of.

| Algorithm | Runs | Limiter p99 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- |
| none | 3 | – | 1.50–1.59 | 501–502 | 48–52 | 0.0%–0.0% |
| token-bucket | 3 | 0.71–0.73 | 1.90–1.93 | 501–502 | 47–52 | 0.0%–0.0% |
