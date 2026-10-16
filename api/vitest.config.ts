import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Several suites import frontend sources (e.g. frontend-path-coverage loads
// frontend/src/lib/api/nativeSettings.ts). Left to itself, Vite's esbuild
// transform resolves the nearest tsconfig.json per file, and
// frontend/tsconfig.json extends ./.svelte-kit/tsconfig.json — generated only
// by `svelte-kit sync`, absent in a clean checkout and in the api CI job. A
// string `tsconfigRaw` makes Vite skip that lookup for every file, so the api
// suite needs no frontend setup. The value carries the api tsconfig's
// esbuild-relevant fields, read here so the two cannot drift.
const ESBUILD_TSCONFIG_FIELDS = [
  'alwaysStrict',
  'experimentalDecorators',
  'importsNotUsedAsValues',
  'preserveValueImports',
  'target',
  'useDefineForClassFields',
  'verbatimModuleSyntax',
];
const apiCompilerOptions: Record<string, unknown> =
  JSON.parse(readFileSync(new URL('./tsconfig.json', import.meta.url), 'utf8')).compilerOptions ?? {};
const tsconfigRaw = JSON.stringify({
  compilerOptions: Object.fromEntries(
    ESBUILD_TSCONFIG_FIELDS.filter((field) => field in apiCompilerOptions).map((field) => [field, apiCompilerOptions[field]]),
  ),
});

export default defineConfig({
  esbuild: {
    target: 'es2022',
    tsconfigRaw,
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
      // CI enforces these floors with test:coverage, including the real-MySQL
      // suites. The fast database-free tier intentionally skips that behavior.
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
