import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
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
  // Native addons + sodium WASM must be marked external (loaded at runtime)
  external: [
    '@node-rs/argon2',
    'libsodium-wrappers',
    'mysql2',
    'phpass',
    'pino-pretty',
    'bcryptjs',
    '@simplewebauthn/server',
    'nodemailer',
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

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const runtimePkg = {
  name: pkg.name,
  type: 'module',
  version: pkg.version,
  engines: pkg.engines,
  dependencies: Object.fromEntries(
    Object.entries(pkg.dependencies as Record<string, string>).filter(([name]) =>
      [
        '@node-rs/argon2',
        'libsodium-wrappers',
        'mysql2',
        'phpass',
        'bcryptjs',
        '@simplewebauthn/server',
        'nodemailer',
        'pino-pretty',
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

console.log('Build complete -> dist/server.js, dist/chatgpt-usage-worker.js');
