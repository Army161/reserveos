import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Database tests reset shared tables between cases. Vitest runs test FILES in
    // parallel worker threads by default, so two files truncating the same
    // database would interleave and produce failures that look like real bugs.
    // The suite is fast enough that serial execution costs little and removes an
    // entire class of flakiness.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
