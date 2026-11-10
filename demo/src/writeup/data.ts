// The write-up's chart data, as the build reads it from docs/decisions/data/
// (demo/build/writeup-data.ts). Types only, so the page can import them without Node.

export type AlgorithmName =
  | 'token-bucket'
  | 'leaky-bucket'
  | 'fixed-window'
  | 'sliding-window-log'
  | 'sliding-window-counter';

/** A benchmark row: `none` is the baseline with no limiter. */
export type BenchAlgorithm = AlgorithmName | 'none';

export interface LatencyRow {
  readonly algorithm: BenchAlgorithm;
  /** The limiter's own time, from `Server-Timing`; null for `none`. */
  readonly limiterP50: number | null;
  readonly limiterP99: number | null;
  readonly e2eP50: number;
  readonly e2eP99: number;
}

export interface EdgesRow {
  readonly algorithm: AlgorithmName;
  /** The most one client got in any window, median of runs. */
  readonly peak: number;
  /** A share, 0 to 1. */
  readonly falseDenials: number;
}

export interface EdgesSeries {
  readonly algorithm: AlgorithmName;
  /** Each allowed request: ms since the client's first, and how many were allowed in its window. */
  readonly points: readonly (readonly [t: number, inWindow: number])[];
}

export interface RampRow {
  readonly algorithm: BenchAlgorithm;
  /** req/s: the busiest healthy second, median of runs. */
  readonly throughput: number;
  /** % of one core at the peak second. */
  readonly redisCpu: number;
}

export interface MemoryRow {
  readonly algorithm: AlgorithmName;
  readonly limit: number;
  readonly bytes: number;
  readonly encoding: string;
}

export interface ChaosRow {
  readonly algorithm: AlgorithmName;
  readonly failed: number;
  /** End-to-end p99 in ms before, during and after the outage. */
  readonly p99: readonly [before: number, during: number, after: number];
  /** A share, 0 to 1. */
  readonly fallbackShare: number;
  readonly peakGoing: number;
  readonly peakComing: number;
  readonly recoveryMs: number;
}

export interface BaselineRow {
  readonly rate: number;
  readonly limiterP50: number;
  readonly limiterP99: number;
  readonly roundTripsPerRequest: number;
}

export interface WriteupData {
  readonly steady: { readonly limit: number; readonly rows: readonly LatencyRow[] };
  readonly edges: {
    readonly limit: number;
    readonly windowMs: number;
    readonly rows: readonly EdgesRow[];
    readonly series: readonly EdgesSeries[];
  };
  readonly ramp: readonly RampRow[];
  readonly memory: readonly MemoryRow[];
  readonly chaos: {
    readonly limit: number;
    readonly killed: readonly ChaosRow[];
    readonly paused: readonly ChaosRow[];
  };
  /** The token bucket at 500 and 15,000 req/s, one round trip per check (0009). */
  readonly baseline: readonly BaselineRow[];
  /** The counter at 15,000 req/s without and with `prometheusHooks()` (0005). */
  readonly metrics: { readonly without: LatencyRow; readonly with: LatencyRow };
}
