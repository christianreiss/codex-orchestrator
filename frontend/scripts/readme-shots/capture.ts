/**
 * Regenerates the README screenshots in docs/img/.
 *
 *   npm run shots:readme                 # every shot
 *   npm run shots:readme -- hosts clients  # only the named shots
 *
 * The console and the agent portal run from their Vite dev servers (started
 * here unless already listening on 4173/4174) against the demo fleet in
 * fixtures.ts, so no orchestrator, database or real data is involved. Each
 * page is captured, then composited into a window frame.
 *
 * The terminal shots render cdx.ansi / clx.ansi: the real
 * terminalui.PrintBootScreen output for a demo ScreenInput, captured under a
 * truecolor PTY. Regenerate those when the wrapper's boot screen changes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { adminFixture, portalFixture } from "./fixtures.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "../..");
const OUT = resolve(FRONTEND, "../docs/img");
const ADMIN = "http://127.0.0.1:4173";
const PORTAL = "http://127.0.0.1:4174";
const SCALE = 1.5;

type Scheme = "light" | "dark";

interface Shot {
  name: string;
  title: string;
  /** Admin route under /admin, or a portal URL path. */
  path?: string;
  app?: "admin" | "portal";
  scheme?: Scheme;
  viewport?: { width: number; height: number };
  /** Terminal persona instead of a browser page. */
  terminal?: "cdx" | "clx";
  prepare?: (page: Page) => Promise<void>;
}

async function openForge(page: Page) {
  await page.getByText("forge.example.net").first().click();
  await page.waitForTimeout(1200);
}

/** Scroll the first element showing `text` to just under the sticky header. */
function scrollTo(text: string) {
  return async (page: Page) => {
    await page.getByText(text, { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.evaluate(() => {
      const scroller = document.querySelector("main")?.closest("[class*='overflow']") ?? document.scrollingElement;
      scroller?.scrollBy(0, -96);
      window.scrollBy(0, -96);
    });
    // The dev server's origin leaks into copyable URLs; show the demo one.
    await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        node.textContent = node.textContent!.replaceAll("http://127.0.0.1:4173", "https://orchestrator.example.net");
      }
    });
    await page.waitForTimeout(300);
  };
}

/** Bring the relationship map to the top and zoom in to a readable level. */
async function focusAtlas(page: Page) {
  await page.getByText("Relationship map").scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h2, h3")].find((el) => el.textContent?.includes("Relationship map"));
    const main = heading?.closest("main") ?? document.scrollingElement;
    const top = heading!.getBoundingClientRect().top;
    (main as Element).scrollBy(0, top - 24);
    window.scrollBy(0, top - 24);
  });
  await page.getByRole("button", { name: "Tags" }).click();
  await page.waitForTimeout(600);
  for (let i = 0; i < 4; i++) await page.locator(".svelte-flow__controls-zoomin").click();
  // Drag the pane so the project and shared clusters sit in view.
  const pane = await page.locator(".svelte-flow__pane").boundingBox();
  if (pane) {
    const x = pane.x + pane.width / 2;
    const y = pane.y + pane.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 120, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForTimeout(600);
}

const SHOTS: Shot[] = [
  { name: "overview", title: "Overview", path: "/dashboard", scheme: "dark" },
  { name: "overview-light", title: "Overview", path: "/dashboard" },
  { name: "cdx-launch", title: "~ — cdx", terminal: "cdx" },
  { name: "clx-launch", title: "~ — clx", terminal: "clx" },
  { name: "hosts", title: "Hosts", path: "/hosts" },
  { name: "active-clients", title: "Active Clients", path: "/clients", prepare: openForge },
  { name: "memory-atlas", title: "Memories", path: "/memories", scheme: "dark", prepare: focusAtlas },
  { name: "project-board", title: "Projects / checkout-v2", path: "/projects/checkout-v2/board" },
  { name: "git-director", title: "Git Director", path: "/git-director", prepare: scrollTo("git@git.example.net:shop/checkout.git") },
  { name: "fleet-instructions", title: "Fleet Instructions", path: "/instructions" },
  { name: "api-access", title: "API Access", path: "/api-keys", prepare: scrollTo("Proxy endpoints") },
  { name: "agent-portal", title: "Agent Portal", app: "portal", path: "/go/", viewport: { width: 430, height: 900 }, prepare: openForge },
];

/* ---------- dev servers ---------- */

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.status < 500;
  } catch {
    return false;
  }
}

async function ensureServer(url: string, args: string[]): Promise<ChildProcess | null> {
  if (await reachable(url)) return null;
  const child = spawn("npx", args, { cwd: FRONTEND, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    if (await reachable(url)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server did not come up at ${url}`);
}

/* ---------- API stubs ---------- */

const unmocked = new Set<string>();

async function stub(page: Page) {
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!request.headers().accept?.includes("application/json")) return route.continue();
    const url = new URL(request.url());
    const body = adminFixture(url.pathname, url.searchParams);
    if (body === undefined) unmocked.add(`${request.method()} ${url.pathname}`);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body ?? { status: "ok" }) });
  });
  await page.route("**/go/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/api/events")) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": idle\n\n" });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(portalFixture(path)) });
  });
  await page.routeWebSocket("**/*ws*", () => {});
}

/* ---------- capture ---------- */

async function capturePage(browser: Browser, shot: Shot): Promise<Buffer> {
  const viewport = shot.viewport ?? { width: 1440, height: 900 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: SCALE, colorScheme: shot.scheme ?? "light", reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await stub(page);
  const base = shot.app === "portal" ? PORTAL : ADMIN;
  const url = shot.app === "portal" ? `${base}${shot.path}` : `${base}/admin${shot.path}`;
  await page.goto(url);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator("h1, h2").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await shot.prepare?.(page);
  // Toasts and the dev-server overlay are noise in a product shot.
  await page.addStyleTag({ content: "[data-sonner-toaster], vite-error-overlay { display: none !important; }" });
  const png = await page.screenshot();
  if (errors.length) console.warn(`  ${shot.name}: page errors\n    ${errors.join("\n    ")}`);
  await context.close();
  return png;
}

/* ---------- terminal ---------- */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Box-drawing and symbol glyphs fall back to another font whose advance
 * differs from the monospace cell, which skews the card's right border.
 * Pinning every non-ASCII glyph to one cell keeps the grid a grid.
 */
function cellHtml(text: string): string {
  return escapeHtml(text).replace(/[^\x00-\x7f]/g, (ch) => `<span class="cell">${ch}</span>`);
}

/** SGR subset the boot screen emits: reset, bold, and 24-bit foregrounds. */
function ansiToHtml(ansi: string): string {
  let bold = false;
  let color: string | null = null;
  let html = "";
  const span = (text: string) => {
    if (!text) return;
    const style = [color ? `color:${color}` : "", bold ? "font-weight:700" : ""].filter(Boolean).join(";");
    html += style ? `<span style="${style}">${cellHtml(text)}</span>` : cellHtml(text);
  };
  const parts = ansi.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      span(parts[i]);
      continue;
    }
    const codes = parts[i].split(";").map(Number);
    for (let j = 0; j < codes.length; j++) {
      const code = codes[j];
      if (code === 0) {
        bold = false;
        color = null;
      } else if (code === 1) bold = true;
      else if (code === 38 && codes[j + 1] === 2) {
        color = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`;
        j += 4;
      }
    }
  }
  return html;
}

function terminalHtml(persona: "cdx" | "clx"): string {
  const ansi = readFileSync(resolve(HERE, `${persona}.ansi`), "utf8");
  const engine = persona === "cdx" ? "codex" : "claude";
  return `<div class="terminal"><pre><span class="prompt">ada@atlas</span> <span class="path">~/src/checkout</span> <span class="dollar">$</span> ${persona}
${ansiToHtml(ansi)}
<span class="dim">Launching ${engine}…</span></pre></div>`;
}

/* ---------- frame ---------- */

const fontFace = (family: string, file: string) =>
  `@font-face{font-family:"${family}";font-weight:100 900;src:url(data:font/woff2;base64,${readFileSync(resolve(FRONTEND, "node_modules", file)).toString("base64")}) format("woff2");}`;

const FONTS =
  fontFace("Inter", "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2") +
  fontFace("JetBrains Mono", "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2");

function frameHtml(shot: Shot, inner: string, width: number, height: number): string {
  const dark = shot.scheme === "dark" || Boolean(shot.terminal);
  const phone = shot.app === "portal";
  return `<!doctype html><html><head><style>
${FONTS}
*{box-sizing:border-box;margin:0}
html,body{width:${width}px;height:${height}px}
body{font-family:Inter,sans-serif;display:grid;place-items:center;overflow:hidden;
  background:
    radial-gradient(60% 70% at 12% 8%, rgba(99,102,241,.55), transparent 60%),
    radial-gradient(55% 60% at 92% 95%, rgba(236,72,153,.35), transparent 60%),
    radial-gradient(40% 50% at 85% 10%, rgba(34,211,238,.25), transparent 60%),
    #0b0d1a;}
body::before{content:"";position:fixed;inset:0;opacity:.35;
  background-image:radial-gradient(rgba(255,255,255,.18) 1px, transparent 1px);background-size:22px 22px;
  mask-image:radial-gradient(70% 70% at 50% 50%, transparent 40%, #000 100%)}
.window{position:relative;border-radius:${phone ? 44 : 14}px;overflow:hidden;
  background:${dark ? "#0f1220" : "#f6f7fb"};
  box-shadow:0 40px 80px -20px rgba(0,0,0,.65),0 0 0 1px rgba(255,255,255,${dark ? ".10" : ".35"});}
.bar{height:40px;display:flex;align-items:center;gap:8px;padding:0 16px;
  background:${dark ? "#161a2c" : "#e9ebf3"};border-bottom:1px solid ${dark ? "rgba(255,255,255,.06)" : "rgba(15,23,42,.08)"}}
.dot{width:12px;height:12px;border-radius:50%}
.title{flex:1;text-align:center;margin-right:52px;font-size:13px;font-weight:500;color:${dark ? "#a5abc3" : "#5b6280"}}
.window img{display:block}
.phone{padding:14px;background:#05060c}
.phone img{border-radius:32px}
.terminal{padding:28px 34px 34px;background:#0c0f1b}
pre{font-family:"JetBrains Mono",monospace;font-size:16px;line-height:1.5;color:#e4e7f2;font-variant-ligatures:none}
.cell{display:inline-block;width:1ch;text-align:center;overflow:visible;white-space:pre}
.prompt{color:#34d399;font-weight:700}.path{color:#60a5fa}.dollar{color:#8b90a5}.dim{color:#8b90a5}
</style></head><body>
<div class="window ${phone ? "phone" : ""}">
${phone ? "" : `<div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">${escapeHtml(shot.title)}</span></div>`}
${inner}
</div></body></html>`;
}

async function compose(browser: Browser, shot: Shot, raw: Buffer | null): Promise<void> {
  let width = 1600;
  let height = 1040;
  let inner: string;
  if (shot.terminal) {
    height = 820;
    inner = terminalHtml(shot.terminal);
  } else {
    const viewport = shot.viewport ?? { width: 1440, height: 900 };
    if (shot.app === "portal") {
      width = 760;
      height = 1040;
    }
    const scale = shot.app === "portal" ? 0.9 : 1;
    inner = `<img src="data:image/png;base64,${raw!.toString("base64")}" width="${viewport.width * scale}" height="${viewport.height * scale}">`;
  }
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: SCALE });
  const page = await context.newPage();
  await page.setContent(frameHtml(shot, inner, width, height));
  await page.evaluate(() => document.fonts.ready);
  const file = resolve(OUT, `${shot.name}.png`);
  writeFileSync(file, await page.screenshot());
  await context.close();
  console.log(`  wrote docs/img/${shot.name}.png`);
}

/* ---------- main ---------- */

const only = new Set(process.argv.slice(2));
const selected = SHOTS.filter((shot) => only.size === 0 || only.has(shot.name));
const needsAdmin = selected.some((s) => s.path && s.app !== "portal");
const needsPortal = selected.some((s) => s.app === "portal");

const servers: (ChildProcess | null)[] = [];
try {
  if (needsAdmin) servers.push(await ensureServer(`${ADMIN}/admin/dashboard`, ["vite", "dev", "--host", "127.0.0.1", "--port", "4173"]));
  if (needsPortal) servers.push(await ensureServer(`${PORTAL}/go/`, ["vite", "--config", "vite.portal.config.ts", "--host", "127.0.0.1", "--port", "4174"]));
  const browser = await chromium.launch();
  for (const shot of selected) {
    const raw = shot.terminal ? null : await capturePage(browser, shot);
    await compose(browser, shot, raw);
  }
  await browser.close();
  if (unmocked.size) console.warn(`unmocked API calls (answered {status:"ok"}):\n  ${[...unmocked].sort().join("\n  ")}`);
} finally {
  for (const child of servers) if (child?.pid) process.kill(-child.pid);
}
