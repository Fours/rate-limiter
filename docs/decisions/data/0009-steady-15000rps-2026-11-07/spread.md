## steady: spread across runs

Lowest–highest value of each metric across the runs that the summary takes the median of.

| Algorithm | Runs | Limiter p99 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- |
| none | 3 | – | 1.32–1.47 | 15021–15023 | 984–989 | 0.0%–0.0% |
| token-bucket | 3 | 0.81–0.86 | 2.24–2.35 | 15009–15035 | 199–199 | 0.0%–0.0% |
