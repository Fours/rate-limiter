import { createTokenBucket } from '../../src/algorithms/token-bucket.js';
import { describeAlgorithm } from '../contract/algorithm-contract.js';
import { FakeClock } from '../helpers/fake-clock.js';

describeAlgorithm(
  'in-memory token bucket',
  () => {
    const clock = new FakeClock();
    const bucket = createTokenBucket({ clock });
    return {
      algorithm: bucket,
      clock,
      close: () => {
        bucket.close();
      },
    };
  },
  {
    burst: (rule) => rule.limit,
    // A full bucket's burst, plus what refills during the rest of the window: just under limit.
    maxPerWindow: (rule) => 2 * rule.limit - 1,
  },
);
