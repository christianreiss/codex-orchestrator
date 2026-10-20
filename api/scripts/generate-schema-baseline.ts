/** Run from api/: npx tsx scripts/generate-schema-baseline.ts [output.sql]. */
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { normalizeBaselineSql } from '../src/db/baseline-generation.js';

const root = resolve(import.meta.dirname, '..');
const baseline = resolve(root, 'src/db/baseline/schema.sql');
const output = process.argv[2] ? resolve(process.argv[2]) : baseline;
if (process.argv.length > 3) throw new Error('Usage: generate-schema-baseline.ts [output.sql]');
const directory = mkdtempSync(resolve(tmpdir(), 'cxx-schema-baseline-'));
const staging = resolve(dirname(output), `.baseline-${randomUUID()}.sql`);
try {
  const result = spawnSync(resolve(root, 'node_modules/.bin/drizzle-kit'), [
    'generate', '--dialect=mysql', '--schema=./src/db/schema.ts', `--out=${directory}`,
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`drizzle-kit exited ${result.status ?? result.signal}`);
  const files = readdirSync(directory).filter((file) => /^0000_.*\.sql$/.test(file));
  if (files.length !== 1) throw new Error('Expected exactly one generated baseline SQL file');
  const header = readFileSync(baseline, 'utf8').split(/\n\s*\n/, 1)[0]!;
  const sql = normalizeBaselineSql(readFileSync(resolve(directory, files[0]!), 'utf8'));
  const freshFeedback = "\n-- Fresh installations select User feedback mode; outbound publication remains opt-in.\nINSERT INTO versions (name, version, updated_at) VALUES ('feedback_mode', 'user', '2026-10-20T00:00:00.000Z') ON DUPLICATE KEY UPDATE name = VALUES(name);\n";
  writeFileSync(staging, `${header}\n\n${sql}${freshFeedback}`);
  renameSync(staging, output);
  process.stdout.write(`Baseline generated: ${output}\n`);
} finally {
  rmSync(staging, { force: true });
  rmSync(directory, { recursive: true, force: true });
}
