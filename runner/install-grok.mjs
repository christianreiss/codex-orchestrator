// Exact official native package; no npm lifecycle scripts or unverified updater.
import { createHash, timingSafeEqual } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const version = '1.0.46';
const packages = {
  amd64: ['x64', 'a9HSDEiXmCFW1sou2xYBZAM1jCDALWU2aNacmsFHztI6kukb8akdI0SlTI43q2uULHzNQlwhrI7GkPcraxM6bQ=='],
  arm64: ['arm64', 'dFSb8PffyHfGHcwGc7xpVWE/GIzDJgg3RLh6aw3mWpvbhSzVDQh5LHRMQ9USdd9SAARuWkIBsg6P7UoeQVJBWw=='],
};
const selected = packages[process.argv[2]];
if (!selected) throw new Error('Unsupported Grok architecture');
const [arch, integrity] = selected;
const url = `https://registry.npmjs.org/@xai-official/grok-linux-${arch}/-/grok-linux-${arch}-${version}.tgz`;
const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Grok native package returned HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const actual = createHash('sha512').update(archive).digest();
if (!timingSafeEqual(actual, Buffer.from(integrity, 'base64'))) throw new Error('Grok native package integrity mismatch');
const tar = gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 });
let binary;
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) break;
  const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
  const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Malformed Grok package tar');
  if (name === 'package/bin/grok.br') {
    if (binary || ![0, 48].includes(header[156])) throw new Error('Unexpected Grok package binary member');
    binary = brotliDecompressSync(tar.subarray(offset + 512, offset + 512 + size), { maxOutputLength: 512 * 1024 * 1024 });
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (!binary?.length) throw new Error('Grok native binary missing from package');
const destination = process.argv[3] ?? '/usr/local/bin/grok';
writeFileSync(destination, binary, { mode: 0o755 });
chmodSync(destination, 0o755);
