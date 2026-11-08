import { createTokenBucket } from '../../src/algorithms/token-bucket.js';
import { describeAlgorithmProperties, traits } from '../contract/algorithm-properties.js';
import { FakeClock } from '../helpers/fake-clock.js';

describeAlgorithmProperties(
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
  traits.tokenBucket,
  { numRuns: 300, maxSteps: 100, timeout: 30_000 },
);
