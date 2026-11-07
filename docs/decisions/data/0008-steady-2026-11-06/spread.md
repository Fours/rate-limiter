## steady: spread across runs

Lowest–highest value of each metric across the runs that the summary takes the median of.

| Algorithm | Runs | Limiter p99 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- |
| none | 3 | – | 1.41–1.52 | 501–501 | 46–49 | 0.0%–0.0% |
| token-bucket | 3 | 0.68–0.74 | 1.81–1.95 | 501–503 | 47–52 | 0.0%–0.0% |
| leaky-bucket | 3 | 0.71–0.74 | 1.78–1.82 | 501–501 | 34–36 | 22.7%–23.3% |
| fixed-window | 3 | 0.69–0.69 | 1.81–1.84 | 501–501 | 45–49 | 0.0%–0.0% |
| sliding-window-log | 3 | 0.69–0.76 | 1.85–1.95 | 501–503 | 46–51 | 0.0%–0.0% |
| sliding-window-counter | 3 | 0.66–0.73 | 1.77–1.92 | 501–502 | 47–49 | 0.0%–0.0% |
