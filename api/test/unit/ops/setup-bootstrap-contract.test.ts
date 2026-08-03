import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The installer is shell, so its contract is asserted by reading it. These are
 * the properties a fresh install silently depends on and that no other test
 * covers: a stack can build, start and look healthy while violating every one
 * of them, and the symptom shows up hours later as a crash-looping container or
 * a console permanently stuck on /setup.
 *
 * Retargeted from `bin/setup.sh`, which is now a shim that execs this script.
 */

const root = resolve(import.meta.dirname, '../../../..');
const install = readFileSync(resolve(root, 'bin/install.sh'), 'utf8');
const shim = readFileSync(resolve(root, 'bin/setup.sh'), 'utf8');
const makefile = readFileSync(resolve(root, 'wrappers/Makefile'), 'utf8');
const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');

describe('fresh-install setup contract', () => {
  it('keeps bin/setup.sh working as a shim', () => {
    expect(shim).toContain('install.sh');
    // Forwarding "$@" would silently accept flags that no longer exist.
    expect(shim).not.toContain('exec "$0"');
  });

  it('writes one generated runner secret under both names', () => {
    // The API and the runner authenticate to each other with this. Two
    // different values build fine and fail every request between them.
    expect(install).toContain('env_set AUTH_RUNNER_SHARED_SECRET "$shared"');
    expect(install).toContain('env_set RUNNER_SHARED_SECRET "$shared"');
    expect(install).toContain('differ; make them identical and re-run');
  });

  it('never writes an ADMIN_ACCESS_MODE the API rejects', () => {
    // `none` is not in the zod enum; the previous quick installer wrote it and
    // every stack it produced refused to boot.
    expect(install).not.toContain('env_set ADMIN_ACCESS_MODE none');
    expect(install).not.toContain('env_set ADMIN_ACCESS_MODE mtls');
    expect(install).toContain('env_set ADMIN_ACCESS_MODE cookie');
  });

  it('deletes the plaintext signing key only after the encrypted import', () => {
    expect(install.indexOf('node setup-signing-key.js')).toBeLessThan(
      install.indexOf('rm -f -- "$WRAPPER_PRIVATE_KEY"'),
    );
  });

  it('refuses to destroy a wrapper matrix it cannot rebuild', () => {
    // --force sets the old matrix aside. Doing that before confirming the
    // private key still exists would throw away the only working artifacts on
    // an installation whose key has already been imported and removed.
    const keyCheck = install.indexOf("this installation's plaintext signing key is gone");
    const destroy = install.indexOf('.superseded.');
    expect(keyCheck).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(-1);
    expect(keyCheck).toBeLessThan(destroy);
  });

  it('injects an installation public key without copying over tracked pubkey.pem', () => {
    expect(makefile).toContain('PUBLIC_KEY_FILE');
    expect(makefile).toContain('signing.buildPublicKeyB64');
    expect(install).not.toContain('make pubkey');
    // The key lives under DATA_ROOT, outside the repo, so the container build
    // has to mount it. Rewriting its path into /src resolves to nothing and the
    // Makefile silently falls back to the tracked CI key.
    expect(install).toContain('-v "$WRAPPER_KEY_DIR:/keys:ro"');
    expect(install).toContain('PUBLIC_KEY_FILE="/keys/');
    // Docker creates a missing bind-mount source as root, and the build runs as
    // the invoking user — which then cannot write its own output.
    const mkdirPublish = install.indexOf('mkdir -p "$publish_root"');
    const dockerRun = install.indexOf('docker run --rm');
    expect(mkdirPublish).toBeGreaterThan(-1);
    expect(mkdirPublish).toBeLessThan(dockerRun);
  });

  it('resolves the data root for steps reached through --only', () => {
    // `--only wrappers` skips step_dataroot, so an unresolved root would make
    // every path below it resolve against `/`.
    expect(install).toContain('require_data_root');
    expect(install).toContain('DATA_ROOT_RESOLVED="$ARG_DATA_ROOT"');
  });

  it('provisions the schema before the API opens a listener', () => {
    // API boot fails closed on a pending migration, so an empty database has to
    // be provisioned between the data tier and the app tier.
    expect(install).toContain('node migrate.js --init-schema');
    const steps = install.slice(install.indexOf('ALL_STEPS=('), install.indexOf(')', install.indexOf('ALL_STEPS=(')));
    expect(steps.indexOf('datatier')).toBeLessThan(steps.indexOf('schema'));
    expect(steps.indexOf('schema')).toBeLessThan(steps.indexOf('apptier'));
  });

  it('requires local and public readiness before printing READY', () => {
    expect(install).toContain('/readyz');
    expect(install).toContain('INCOMPLETE');
    expect(install.indexOf('run_checks')).toBeLessThan(install.lastIndexOf('READY'));
  });

  it('exports the env file into compose rather than only naming it', () => {
    // Keys listed under `environment:` shadow `env_file:`, and their
    // `${VAR:-default}` interpolates from compose's own environment. Naming
    // ENV_FILE alone resolves AUTH_RUNNER_SHARED_SECRET to empty and mounts the
    // default DATA_ROOT.
    expect(install).toContain('ENV_FILE=$ENV_PATH');
    expect(install).toContain('DATA_ROOT=$DATA_ROOT_RESOLVED');
    expect(compose).toContain('AUTH_RUNNER_SHARED_SECRET: ${AUTH_RUNNER_SHARED_SECRET:-}');
  });

  it('persists Caddy ACME state across container recreation', () => {
    // Without these the account key and every issued certificate die on
    // `docker compose down`, and a few redeploys hit Let's Encrypt's duplicate
    // limit.
    expect(compose).toContain('caddy_data:/data');
    expect(compose).toContain('caddy_config:/config');
    expect(compose).toMatch(/^volumes:/m);
  });

  it('keeps no client-certificate machinery', () => {
    expect(install).not.toMatch(/--mtls-/);
    expect(install).not.toContain('generate_client_cert');
    expect(compose).not.toContain('CADDY_MTLS_CA_FILE');
    expect(compose).not.toContain('admin-mtls.caddy');
  });
});
