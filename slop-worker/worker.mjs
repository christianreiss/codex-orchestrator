// Slop worker: runs the pinned slop-detector CLI on run directories the API
// materializes under $DATA_ROOT/slop/runs/<run-id>/. Protocol (docs/interface-api.md
// "Slop jobs"): the API atomically writes `<task>.request.json` (task = scan | report);
// this worker answers with an atomic `<task>.result.json`. No network, no shell:
// the CLI only reads files, and uploaded content is never executed.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(process.env.DATA_ROOT ?? '/app/storage', 'slop', 'runs');
const SLOP = process.env.SLOP_HOME ?? '/opt/slop';
const CLI = join(SLOP, 'dist', 'cli.js');
const TASKS = ['scan', 'report'];
const TIMEOUT_MS = 120_000;
const MAX_PARALLEL = 2;
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const running = new Set();
const queue = [];

function run(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      // uid 10001 has no passwd entry: without HOME, os.homedir() (called by
      // playwright-core at import time) throws ENOENT. /tmp is the only writable tmpfs.
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'production',
        HOME: '/tmp',
        XDG_CACHE_HOME: '/tmp/.cache',
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-200_000)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4_000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(error) });
    });
  });
}

async function publish(directory, task, value) {
  const tmp = join(directory, `${task}.result.tmp`);
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, join(directory, `${task}.result.json`));
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

let versionCache = null;
async function slopVersion() {
  if (!versionCache) versionCache = JSON.parse(await readFile(join(SLOP, 'package.json'), 'utf8')).version;
  return versionCache;
}

/** Guidelines + rubric for full reviews, one file, hashed so runs record what judged them. */
async function guidelines(directory) {
  const names = (await readdir(SLOP)).filter((n) => /^0\d-.*\.md$/.test(n)).sort();
  const rubric = (await run(['rubric'], SLOP)).stdout.trim();
  const parts = [`# Slop rubric\n\n${rubric}\n`];
  for (const name of names) parts.push(`\n\n<!-- ${name} -->\n\n${await readFile(join(SLOP, name), 'utf8')}`);
  const body = parts.join('');
  await writeFile(join(directory, 'guidelines.md'), body);
  return createHash('sha256').update(body).digest('hex');
}

async function process_(directory, task) {
  const request = await readJson(join(directory, `${task}.request.json`));
  if (!request) return;
  const version = await slopVersion();
  const tree = join(directory, 'tree');
  await mkdir(tree, { recursive: true });
  let result;
  if (task === 'scan') {
    result = await run(['scan', '.', '--root', tree, '--out', join(directory, 'out'), '--format', 'json'], tree);
    const report = await readJson(join(directory, 'out', 'scan.json'));
    const extra = request.full ? { guidelines_sha256: await guidelines(directory) } : {};
    await publish(directory, task, {
      state: report ? 'done' : 'failed',
      exit_code: result.code,
      slop_version: version,
      report,
      stderr: result.stderr,
      ...extra,
    });
    return;
  }
  result = await run(
    [
      'report',
      join(directory, 'out', 'scan.json'),
      '--review',
      join(directory, 'review.json'),
      '--root',
      tree,
      '--out',
      join(directory, 'final'),
      '--format',
      'json',
    ],
    tree,
  );
  const report = await readJson(join(directory, 'final', 'report.json'));
  await publish(directory, task, {
    state: report ? 'done' : 'failed',
    exit_code: result.code,
    slop_version: version,
    report,
    stderr: result.stderr,
  });
}

async function pending(directory) {
  const found = [];
  for (const task of TASKS) {
    try {
      await stat(join(directory, `${task}.request.json`));
    } catch {
      continue;
    }
    try {
      await stat(join(directory, `${task}.result.json`));
    } catch {
      found.push(task);
    }
  }
  return found;
}

function schedule(id) {
  if (!RUN_ID.test(id) || running.has(id) || queue.includes(id)) return;
  queue.push(id);
  pump();
}

function pump() {
  while (running.size < MAX_PARALLEL && queue.length) {
    const id = queue.shift();
    running.add(id);
    const directory = join(ROOT, id);
    (async () => {
      for (const task of await pending(directory)) {
        try {
          await process_(directory, task);
        } catch (error) {
          await publish(directory, task, { state: 'failed', exit_code: 1, stderr: String(error).slice(-4000) }).catch(
            () => {},
          );
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        running.delete(id);
        pump();
      });
  }
}

async function rescan() {
  let entries = [];
  try {
    entries = await readdir(ROOT);
  } catch {
    return;
  }
  for (const id of entries) if ((await pending(join(ROOT, id)).catch(() => [])).length) schedule(id);
}

await mkdir(ROOT, { recursive: true });
watch(ROOT, { recursive: true, persistent: true }, (_event, name) => {
  if (!name) return;
  const [id, file] = String(name).split('/');
  if (file && file.endsWith('.request.json')) schedule(id);
}).on('error', () => {});
// The watch is the fast path; a periodic rescan covers missed events and restarts.
setInterval(rescan, 5_000);
await rescan();
console.log(`slop-worker ready: slop ${await slopVersion()} watching ${ROOT}`);
