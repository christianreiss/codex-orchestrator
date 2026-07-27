import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    target: 'es2022',
  },
  test: {
    globals: false,
    environment: 'node',
    env: {
      // Most lifecycle fixtures use compact redacted tokens. Production keeps
      // the documented default of 24; dedicated validation tests cover it.
      TOKEN_MIN_LENGTH: '8',
    },
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/db/migrations/**', 'src/**/*.d.ts'],
      // The measured floor, not an aspiration: CI enforces these, so they have
      // to sit at or below what the suite actually covers today. Raise them as
      // coverage climbs.
      thresholds: {
        branches: 73,
        functions: 74,
        lines: 65,
        statements: 65,
      },
    },
    pool: 'forks',
    testTimeout: 20000,
  },
});
