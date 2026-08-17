import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
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
  // tracing off. Everything listed here is checked against the declared
  // dependencies below, and the build fails on a specifier the image could not
  // resolve — the list used to name `phpass`, which is an inline port under
  // `src/security/`, never an installed package.
  external: [
    '@node-rs/argon2',
    'libsodium-wrappers',
    'mysql2',
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

// `migrate.js --init-schema` reads the starting schema from `baseline/` beside
// the bundle, resolved by `defaultBaselineFile()` exactly the way migrations are.
// Fail loudly if it is missing: a silent omission here is a fresh install that
// cannot create its database, discovered only on the target machine.
const baselineSrc = resolve(root, 'src/db/baseline/schema.sql');
if (!existsSync(baselineSrc)) throw new Error(`baseline schema not found at ${baselineSrc}`);
mkdirSync(resolve(dist, 'baseline'), { recursive: true });
copyFileSync(baselineSrc, resolve(dist, 'baseline', 'schema.sql'));

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  engines?: Record<string, string>;
  dependencies: Record<string, string>;
};

// Every specifier that stays external either ships in the image or is proven
// unreachable in production. `pino-pretty` is the only member of the second
// group: `loggerOptions()` selects it exclusively when `NODE_ENV !== 'production'`,
// and the runtime image pins `NODE_ENV=production`, so bundling it would drag a
// dev formatter into every image for a code path that cannot run there.
const DEV_ONLY_EXTERNALS = new Set(['pino-pretty']);
const runtimeExternals = (sharedBuildOptions.external ?? []).filter(
  (name) => !DEV_ONLY_EXTERNALS.has(name),
);

const missingFromDeps = runtimeExternals.filter((name) => !(name in pkg.dependencies));
if (missingFromDeps.length > 0) {
  throw new Error(
    `esbuild externals are not declared dependencies, so the image would ship an unresolvable import: ${missingFromDeps.join(', ')}`,
  );
}

// The image installs with `npm ci`, which needs a lockfile whose root entry
// matches the package.json beside it. Rather than hand the image a set of
// semver ranges to resolve again at build time — a different tree every
// rebuild — carve the exact closure of the external packages out of the api
// lockfile and ship that. Same integrity hashes, same versions, offline.
const lockPath = resolve(root, 'package-lock.json');
if (!existsSync(lockPath))
  throw new Error(`package-lock.json is required to build a deterministic image (${lockPath})`);
const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
};
if (lock.lockfileVersion < 3)
  throw new Error(`unsupported lockfileVersion ${lock.lockfileVersion}; expected 3 or newer`);

const { entries: runtimeLockEntries, versions: runtimeVersions } = pruneLockfile(
  lock.packages,
  runtimeExternals,
);

const runtimePkg = {
  name: pkg.name,
  type: 'module',
  version: pkg.version,
  engines: pkg.engines,
  dependencies: Object.fromEntries(runtimeExternals.map((name) => [name, runtimeVersions[name]])),
};
writeFileSync(resolve(dist, 'package.json'), JSON.stringify(runtimePkg, null, 2));

writeFileSync(
  resolve(dist, 'package-lock.json'),
  JSON.stringify(
    {
      name: runtimePkg.name,
      version: runtimePkg.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: runtimePkg.name,
          version: runtimePkg.version,
          dependencies: runtimePkg.dependencies,
          ...(runtimePkg.engines ? { engines: runtimePkg.engines } : {}),
        },
        ...runtimeLockEntries,
      },
    },
    null,
    2,
  ),
);

// Deliberately absent: a copy of `../.env` into `dist/`. The build output is
// baked into the image and shipped; runtime configuration comes from the
// environment or an explicitly mounted secret file, never from a secret the
// build inlined. `test/unit/ops/build-artifact-secrets.test.ts` runs the real
// build against a sentinel `.env` and fails if anything secret-shaped lands
// under `dist/`.

console.log(
  `Build complete -> dist/server.js, dist/chatgpt-usage-worker.js, dist/migrate.js, dist/setup-signing-key.js, dist/rotate-signing-key.js, dist/migrations/ (${migrations.length} files), dist/baseline/schema.sql, dist/package-lock.json (${Object.keys(runtimeLockEntries).length} packages)`,
);

interface LockEntry {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  dev?: boolean;
  devOptional?: boolean;
  [key: string]: unknown;
}

/**
 * npm resolves `name` for the package installed at `from` by looking in that
 * package's own `node_modules` first and then walking up the tree. Mirror that
 * walk so a hoisted copy and a nested copy each land on the entry npm would use.
 */
function resolveLockPath(
  packages: Record<string, LockEntry>,
  from: string,
  name: string,
): string | null {
  let base = from;
  for (;;) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (base === '') return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

/**
 * Reduce a full lockfile to the closure reachable from `roots`, keeping each
 * entry byte-identical (version, `resolved`, `integrity`, `os`/`cpu` gates) so
 * `npm ci` inside the image installs exactly what CI resolved.
 *
 * Optional dependencies stay in: `@node-rs/argon2` ships its native binding as
 * fourteen per-platform optional packages, and dropping them leaves the image
 * with a pure-JS-less argon2. Peer dependencies stay in only when the parent
 * does not mark them optional, because npm refuses to build a tree that is
 * missing a required peer.
 */
function pruneLockfile(
  packages: Record<string, LockEntry>,
  roots: readonly string[],
): { entries: Record<string, LockEntry>; versions: Record<string, string> } {
  const entries: Record<string, LockEntry> = {};
  const versions: Record<string, string> = {};
  const queue: string[] = [];

  for (const name of roots) {
    const path = resolveLockPath(packages, '', name);
    if (!path) throw new Error(`external dependency ${name} is absent from package-lock.json`);
    const version = packages[path]?.version;
    if (!version) throw new Error(`lockfile entry ${path} has no version`);
    versions[name] = version;
    queue.push(path);
  }

  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (path in entries) continue;
    const source = packages[path];
    if (!source) throw new Error(`lockfile entry ${path} disappeared while walking the closure`);
    const { dev: _dev, devOptional: _devOptional, ...kept } = source;
    entries[path] = kept;

    const required = {
      ...(source.dependencies ?? {}),
      ...(source.optionalDependencies ?? {}),
      ...Object.fromEntries(
        Object.entries(source.peerDependencies ?? {}).filter(
          ([peer]) => source.peerDependenciesMeta?.[peer]?.optional !== true,
        ),
      ),
    };
    for (const name of Object.keys(required)) {
      const next = resolveLockPath(packages, path, name);
      // An optional dependency for another platform is legitimately absent from
      // a lockfile resolved on this one; a missing required dependency is not.
      if (!next) {
        if (name in (source.optionalDependencies ?? {})) continue;
        throw new Error(`lockfile entry ${path} requires ${name}, which is not in the lockfile`);
      }
      if (!(next in entries)) queue.push(next);
    }
  }

  return { entries, versions };
}
