import { createTokenBucket } from '../src/algorithms/token-bucket.js';
import { describeMiddleware } from './contract/middleware-contract.js';
import { FakeClock } from './helpers/fake-clock.js';

describeMiddleware(
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
  { burst: (rule) => rule.limit },
);
