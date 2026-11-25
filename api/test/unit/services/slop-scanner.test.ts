import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Load the worker's separately compiled TypeScript without adding it to the API build root.
const scannerPath = new URL('../../../../slop-worker/vendor/slop-detector/src/core.ts', import.meta.url).pathname;
const { scan } = await import(scannerPath);

describe('vendored slop source coverage and typography', () => {
  it('ignores product text and identifiers but detects declared font choices', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slop-font-'));
    try {
      await writeFile(join(dir, 'app.html'), `<title>DALASON Internal Services</title>\n<option>International</option>\n<script>new IntersectionObserver(() => {})</script>\n<style>body { font-family: Inter, sans-serif; }</style>\n<div style="font-family: Internal">Internal</div>`);
      const report = await scan(dir, ['app.html']);
      expect(report.findings.filter((f: { rule: string }) => f.rule === 'type-default').map((f: { location: string }) => f.location)).toEqual(['app.html:4']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reports unsupported Kotlin files explicitly instead of implying scanned coverage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slop-kotlin-'));
    try {
      await writeFile(join(dir, 'View.kt'), '@Composable fun View() {}');
      const report = await scan(dir, ['View.kt']);
      expect(report.sources).toEqual({});
      expect(report.coverage).toContain('Source scan: 0 files. Browser behavior not tested.');
      expect(report.coverage).toContain('Skipped: 1 unsupported extension.');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('names skipped unsupported extensions and the extensions the rules cover', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slop-ext-'));
    try {
      await writeFile(join(dir, 'View.kt'), 'fun a() {}');
      await writeFile(join(dir, 'Other.KT'), 'fun b() {}');
      await writeFile(join(dir, 'page.php'), '<?php echo 1;');
      await writeFile(join(dir, 'app.ts'), 'export const a = 1;');
      const report = await scan(dir, ['View.kt', 'Other.KT', 'page.php', 'app.ts']);
      const line = report.coverage.find((c: string) => c.startsWith('Unsupported extensions skipped:'));
      expect(line).toMatch(/^Unsupported extensions skipped: \.kt \(2\), \.php \(1\)\. Deterministic rules cover only \.ts \.tsx /);
      expect(line).toContain(' .swift .qml .cpp ');
      expect(Object.keys(report.sources)).toEqual(['app.ts']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('adds no extension note when every source is supported', async () => {
    const report = await scanText('ok.ts', 'export const a = 1;');
    expect(report.coverage.some((c: string) => c.startsWith('Unsupported extensions'))).toBe(false);
  });
});

async function scanText(name: string, text: string) {
  const dir = await mkdtemp(join(tmpdir(), 'slop-context-'));
  try {
    await writeFile(join(dir, name), text);
    return await scan(dir, [name]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('Slop contextual web signals', () => {
  it.each([
    'dialog::backdrop { background:#172f294d; backdrop-filter:blur(3px); }',
    'dialog[open]::backdrop {\n backdrop-filter: blur(3px);\n}',
  ])('recognizes the native modal backdrop role: %s', async (text) => {
    expect((await scanText('modal.css', text)).findings.filter((f: {rule: string}) => f.rule === 'card-kit')).toEqual([]);
  });
  it.each([
    '.card { backdrop-filter:blur(3px); }',
    'dialog::backdrop, .card { backdrop-filter:blur(3px); }',
    'dialog::backdrop { background:black; }\n.card { backdrop-filter:blur(3px); }',
    'dialog::backdrop { backdrop-filter:blur(3px); } .card { backdrop-filter:blur(3px); }',
  ])('retains real glass-container findings: %s', async (text) => {
    expect((await scanText('cards.css', text)).findings.some((f: {rule: string}) => f.rule === 'card-kit')).toBe(true);
  });
  it.each([
    '<button class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Save</button>',
    '<button\n class="outline-none\n focus-visible:ring-2 focus-visible:ring-ring"\n>Save</button>',
    '<button class="outline-none focus-visible:ring-2 focus-visible:ring-primary/50">Save</button>',
  ])('recognizes replacement focus on the same element: %s', async (text) => {
    expect((await scanText('button.svelte', text)).findings.filter((f: {rule: string}) => f.rule === 'focus')).toEqual([]);
  });
  it.each([
    ['button.svelte', '<button class={cn("rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "bg-muted")}>Save</button>'],
    ['button.svelte', '<button class={["outline-none focus-visible:ring-2", active ? "a" : "b"]}>Save</button>'],
    ['button.tsx', "<button className={clsx('outline-none focus:ring-2')}>Save</button>"],
    ['classes.ts', 'export const button = `outline-none\n focus-visible:ring-2`;'],
    ['button.css', 'button { @apply outline-none focus:ring-2; }'],
  ])('recognizes replacement focus within a class literal or @apply (%s)', async (name, text) => {
    expect((await scanText(name, text)).findings.filter((f: {rule: string}) => f.rule === 'focus')).toEqual([]);
  });
  it.each([
    '<button class="outline-none">Save</button><button class="focus-visible:ring-2">Other</button>',
    '<button class={cn("outline-none", active && "focus-visible:ring-2")}>Save</button>',
    '<button class={["outline-none", "focus-visible:ring-2"]}>Save</button>',
    '<button class={cn("outline-none focus-visible:ring-2", "outline-none")}>Save</button>',
    '<button class={cn(`outline-none ${enabled ? "focus-visible:ring-2" : ""}`)}>Save</button>',
    'button { @apply outline-none; } .other { @apply focus-visible:ring-2; }',
    '<button class="outline-none focus-visible:ring-ring">Save</button>',
    '<button class="outline-none focus-visible:ring-0">Save</button>',
    '<button class="focus-visible:outline-none focus-visible:outline-2">Save</button>',
    '<button class="outline-none focus-visible:ring-2 focus-visible:ring-transparent">Save</button>',
    '<button class="outline-none focus-visible:ring-2">Save</button><button class="outline-none">Other</button>',
    '<button class="outline-none hover:ring-2">Save</button>',
    '<button class="outline-none focus-visible:ring-2 focus-visible:ring-0">Save</button>',
    '<button class="outline-none {active ? \'focus-visible:ring-2\' : \'\'}">Save</button>',
    'button { outline:none; }\n.other:focus-visible { outline:2px solid; }',
    '<button class="outline-none focus-visible:outline-2">Save</button>',
    '<button class="outline-none focus-visible:ring-2 focus-visible:ring-primary/0">Save</button>',
    '<button class="outline-none focus-visible:ring-2 focus-visible:ring-primary/[0]">Save</button>',
    '<button class="outline-none focus-visible:ring-2 focus-visible:ring-[transparent]">Save</button>',
    '<button class="outline-none focus-visible:ring-2 focus-visible:ring-opacity-[var(--alpha)]">Save</button>',
  ])('keeps missing or uncertain focus replacement reviewable: %s', async (text) => {
    expect((await scanText('button.svelte', text)).findings.some((f: {rule: string}) => f.rule === 'focus')).toBe(true);
  });
  it('keeps Go and PTY text out of deterministic source coverage', async () => {
    for (const name of ['view.go', 'pty.txt']) {
      const report = await scanText(name, 'terminal state');
      expect(report.sources).toEqual({});
      expect(report.coverage).toContain('Source scan: 0 files. Browser behavior not tested.');
      expect(report.coverage).toContain('Skipped: 1 unsupported extension.');
    }
  });
});
