import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');

mkdirSync(dist, { recursive: true });

const sharedBuildOptions: Omit<esbuild.BuildOptions, 'entryPoints' | 'outfile'> = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: true,
  // Native addons + sodium WASM must be marked external (loaded at runtime).
  // The @opentelemetry/* entries are external for a different reason: they are
  // `await import()`ed only when OTEL_TRACES_ENABLED is set, and bundling them
  // would pull the SDK into the image's hot path for every operator who leaves
  // tracing off. Anything listed here MUST also appear in the runtime
  // dependency allowlist below, or the image ships an unresolvable import.
  external: [
    '@node-rs/argon2',
    'libsodium-wrappers',
    'mysql2',
    'phpass',
    'pino-pretty',
    'bcryptjs',
    '@simplewebauthn/server',
    'nodemailer',
    '@opentelemetry/api',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-node',
  ],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};

await esbuild.build({
  ...sharedBuildOptions,
  entryPoints: [resolve(root, 'src/server.ts')],
  outfile: resolve(dist, 'server.js'),
});

await esbuild.build({
  ...sharedBuildOptions,
  entryPoints: [resolve(root, 'src/ops/chatgpt-usage-worker.ts')],
  outfile: resolve(dist, 'chatgpt-usage-worker.js'),
});

await esbuild.build({
  ...sharedBuildOptions,
  entryPoints: [resolve(root, 'src/db/migrate-cli.ts')],
  outfile: resolve(dist, 'migrate.js'),
});

await esbuild.build({
  ...sharedBuildOptions,
  entryPoints: [resolve(root, 'src/ops/setup-signing-key.ts')],
  outfile: resolve(dist, 'setup-signing-key.js'),
});

// Signing-key rotation is an in-image operator action like the import above,
// so it ships as its own entry point rather than needing a source checkout.
await esbuild.build({
  ...sharedBuildOptions,
  entryPoints: [resolve(root, 'src/ops/rotate-signing-key.ts')],
  outfile: resolve(dist, 'rotate-signing-key.js'),
});

// The migration runner reads its SQL from `migrations/` next to the bundle —
// `src/db/migrations` under tsx, `dist/migrations` in the image. Copy by
// directory listing, never by an enumerated list: a migration that gets left
// out of the image is a schema change that silently never ships.
const migrationsSrc = resolve(root, 'src/db/migrations');
const migrationsDist = resolve(dist, 'migrations');
mkdirSync(migrationsDist, { recursive: true });
const migrations = readdirSync(migrationsSrc).filter((file) => file.endsWith('.sql'));
if (migrations.length === 0) throw new Error(`no migrations found in ${migrationsSrc}`);
for (const file of migrations) {
  copyFileSync(resolve(migrationsSrc, file), resolve(migrationsDist, file));
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const runtimePkg = {
  name: pkg.name,
  type: 'module',
  version: pkg.version,
  engines: pkg.engines,
  dependencies: Object.fromEntries(
    Object.entries(pkg.dependencies as Record<string, string>).filter(([name]) =>
      // Mirror of the esbuild `external` list above: every specifier that stays
      // external has to be installable inside the image.
      [
        '@node-rs/argon2',
        'libsodium-wrappers',
        'mysql2',
        'phpass',
        'bcryptjs',
        '@simplewebauthn/server',
        'nodemailer',
        'pino-pretty',
        '@opentelemetry/api',
        '@opentelemetry/exporter-trace-otlp-http',
        '@opentelemetry/resources',
        '@opentelemetry/sdk-trace-node',
      ].includes(name),
    ),
  ),
};
writeFileSync(resolve(dist, 'package.json'), JSON.stringify(runtimePkg, null, 2));

try {
  copyFileSync(resolve(root, '../.env'), resolve(dist, '.env'));
} catch {
  // .env optional at build time
}

console.log(
  `Build complete -> dist/server.js, dist/chatgpt-usage-worker.js, dist/migrate.js, dist/setup-signing-key.js, dist/rotate-signing-key.js, dist/migrations/ (${migrations.length} files)`,
);
