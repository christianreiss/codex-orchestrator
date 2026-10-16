import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Executes bin/lib/selfsigned-tls.sh against real openssl. The defect it
 * guards against — a CA without keyUsage — is accepted by curl and Go and only
 * rejected by X509_STRICT clients (Python 3.13+), so the assertion is the
 * strict verify itself, not the presence of a config line.
 */

const script = resolve(import.meta.dirname, '../../../../bin/lib/selfsigned-tls.sh');
const dirs: string[] = [];
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'selfsigned-tls-'));
  dirs.push(dir);
  return dir;
}

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });
}

function ext(cert: string) {
  return run('openssl', ['x509', '-in', cert, '-noout', '-text']).stdout;
}

function strictVerify(ca: string, leaf: string) {
  return run('openssl', ['verify', '-x509_strict', '-CAfile', ca, leaf]);
}

/** What the installer wrote before this fix: stock `req -x509`, no keyUsage. */
function legacyMaterial(dir: string) {
  const o = (args: string[]) => expect(run('openssl', args).status).toBe(0);
  o(['req', '-x509', '-new', '-nodes', '-sha256', '-days', '3650', '-subj', '/CN=example.test Local CA',
    '-newkey', 'rsa:2048', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt')]);
  writeFileSync(join(dir, 'server.ext'), '[v3_req]\nbasicConstraints = CA:FALSE\nkeyUsage = digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:example.test\n');
  o(['req', '-new', '-nodes', '-newkey', 'rsa:2048', '-keyout', join(dir, 'server.key'), '-subj', '/CN=example.test',
    '-out', join(dir, 'server.csr')]);
  o(['x509', '-req', '-in', join(dir, 'server.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'),
    '-CAcreateserial', '-out', join(dir, 'server.crt'), '-days', '825', '-sha256',
    '-extfile', join(dir, 'server.ext'), '-extensions', 'v3_req']);
  rmSync(join(dir, 'server.csr'));
  rmSync(join(dir, 'server.ext'));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasOpenssl)('selfsigned-tls.sh', () => {
  it('issues a CA and leaf that pass strict verification', () => {
    const dir = tmp();
    const r = run('bash', [script, 'issue', dir, 'example.test', 'localhost,127.0.0.1']);
    expect(r.status, r.stderr).toBe(0);

    const ca = ext(join(dir, 'ca.crt'));
    expect(ca).toMatch(/Basic Constraints: critical\s+CA:TRUE/);
    expect(ca).toMatch(/Key Usage: critical\s+Certificate Sign, CRL Sign/);
    expect(ca).toContain('Subject Key Identifier');

    const leaf = ext(join(dir, 'server.crt'));
    expect(leaf).toMatch(/Basic Constraints: critical\s+CA:FALSE/);
    expect(leaf).toMatch(/Key Usage: critical\s+Digital Signature, Key Encipherment/);
    expect(leaf).toMatch(/Extended Key Usage:\s+TLS Web Server Authentication/);
    expect(leaf).toContain('Authority Key Identifier');
    for (const san of ['IP Address:127.0.0.1', 'DNS:localhost', 'DNS:example.test']) expect(leaf).toContain(san);

    expect(strictVerify(join(dir, 'ca.crt'), join(dir, 'server.crt')).status).toBe(0);
  });

  it('is idempotent once the material is compliant', () => {
    const dir = tmp();
    expect(run('bash', [script, 'issue', dir, 'example.test']).status).toBe(0);
    const before = ['ca.crt', 'ca.key', 'server.crt', 'server.key'].map((f) => readFileSync(join(dir, f), 'utf8'));
    const again = run('bash', [script, 'issue', dir, 'example.test']);
    expect(again.status).toBe(0);
    expect(again.stderr).toContain('nothing to do');
    const after = ['ca.crt', 'ca.key', 'server.crt', 'server.key'].map((f) => readFileSync(join(dir, f), 'utf8'));
    expect(after).toEqual(before);
  });

  it('repairs a legacy CA without losing the trust old clients hold', () => {
    const dir = tmp();
    legacyMaterial(dir);
    const oldCa = join(dir, 'old-ca.pem');
    const oldLeaf = join(dir, 'old-leaf.pem');
    copyFileSync(join(dir, 'ca.crt'), oldCa);
    copyFileSync(join(dir, 'server.crt'), oldLeaf);
    const caKey = readFileSync(join(dir, 'ca.key'), 'utf8');
    const serverKey = readFileSync(join(dir, 'server.key'), 'utf8');

    // The reported failure, reproduced.
    expect(strictVerify(oldCa, oldLeaf).stdout + strictVerify(oldCa, oldLeaf).stderr).toContain('key usage');
    expect(run('bash', [script, 'check', dir]).status).toBe(1);

    const r = run('bash', [script, 'issue', dir, 'example.test', 'example.test']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('re-signing ca.crt from the existing ca.key');

    // Keys and the CA's identity are untouched; the old certificate is kept.
    expect(readFileSync(join(dir, 'ca.key'), 'utf8')).toBe(caKey);
    expect(readFileSync(join(dir, 'server.key'), 'utf8')).toBe(serverKey);
    const subjectSki = (cert: string) =>
      run('openssl', ['x509', '-in', cert, '-noout', '-subject', '-ext', 'subjectKeyIdentifier']).stdout;
    expect(subjectSki(join(dir, 'ca.crt'))).toBe(subjectSki(oldCa));
    expect(readdirSync(dir).some((f) => f.startsWith('ca.crt.legacy-'))).toBe(true);

    // New clients verify strictly; old clients and old leaves keep working.
    expect(strictVerify(join(dir, 'ca.crt'), join(dir, 'server.crt')).status).toBe(0);
    expect(run('openssl', ['verify', '-CAfile', oldCa, join(dir, 'server.crt')]).status).toBe(0);
    expect(run('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), oldLeaf]).status).toBe(0);
    expect(run('bash', [script, 'check', dir]).status).toBe(0);
  });

  it('refuses to mint a new CA over a certificate whose key is missing', () => {
    const dir = tmp();
    legacyMaterial(dir);
    rmSync(join(dir, 'ca.key'));
    const r = run('bash', [script, 'issue', dir, 'example.test']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('exists without ca.key');
  });
});
