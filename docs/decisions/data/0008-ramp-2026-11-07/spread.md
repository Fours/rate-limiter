## ramp: spread across runs

Lowest–highest value of each metric across the runs that the summary takes the median of.

| Algorithm | Runs | Limiter p99 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |
| --- | --- | --- | --- | --- | --- | --- |
| none | 3 | – | – | 42003–48023 | – | – |
| token-bucket | 3 | – | – | 38290–39461 | – | – |
| leaky-bucket | 3 | – | – | 38427–39058 | – | – |
| fixed-window | 3 | – | – | 39565–40974 | – | – |
| sliding-window-log | 3 | – | – | 38855–42152 | – | – |
| sliding-window-counter | 3 | – | – | 37984–39800 | – | – |
