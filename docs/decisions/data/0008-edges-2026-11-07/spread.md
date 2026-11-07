## edges: spread across runs

Lowest–highest value of each metric across the runs that the summary takes the median of.

| Algorithm | Runs | Limiter p99 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- |
| token-bucket | 3 | 1.29–1.35 | 3.11–3.22 | 1047–1050 | 154–155 | 0.0%–0.0% |
| leaky-bucket | 3 | 1.29–1.34 | 3.16–3.30 | 1049–1050 | 53–54 | 68.6%–70.4% |
| fixed-window | 3 | 1.36–1.38 | 3.18–3.19 | 1049–1050 | 200–200 | 0.0%–0.0% |
| sliding-window-log | 3 | 1.34–1.42 | 3.19–3.33 | 1049–1050 | 100–100 | 0.0%–0.0% |
| sliding-window-counter | 3 | 1.31–1.33 | 3.15–3.21 | 1049–1051 | 104–143 | 13.4%–15.2% |
