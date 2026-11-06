import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { blank, finding } from "./core.js";
export const CaptureConfig = z.object({
  routes: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        url: z.string().url(),
        state: z.string().min(1),
      }),
    )
    .min(1),
  requiredStates: z
    .array(z.string())
    .default([
      "loaded",
      "loading",
      "empty",
      "error",
      "no-access",
      "success",
      "saving",
    ]),
  widths: z
    .array(z.number().int().min(320).max(3840))
    .default([320, 390, 768, 1440]),
});
export async function capture(config: unknown, out: string) {
  const c = CaptureConfig.parse(config),
    r = blank();
  await mkdir(out, { recursive: true });
  if (new Set(c.routes.map((x) => x.name)).size !== c.routes.length)
    throw Error("Route names must be unique");
  for (const s of c.requiredStates)
    if (!c.routes.some((x) => x.state === s))
      r.errors.push(`Missing required state: ${s}`);
  let browser;
  try {
    browser = await chromium.launch();
    for (const route of c.routes)
      for (const width of c.widths) {
        const key = `${route.name}-${width}`;
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        try {
          const response = await page.goto(route.url, {
            waitUntil: "networkidle",
            timeout: 15000,
          });
          if (!response?.ok()) throw Error(`HTTP ${response?.status()}`);
          await page.screenshot({
            path: path.join(out, key + ".png"),
            fullPage: true,
          });
          await writeFile(path.join(out, key + ".html"), await page.content());
          const results = await new AxeBuilder({ page }).analyze();
          await writeFile(
            path.join(out, key + ".axe.json"),
            JSON.stringify(results, null, 2),
          );
          for (const v of results.violations)
            for (const n of v.nodes)
              r.findings.push(
                finding(
                  `axe:${v.id}`,
                  `${key}: ${n.target.join(" ")}`,
                  n.html,
                  v.help,
                  `Resolve ${v.id}: ${n.failureSummary || v.help}`,
                  `Rerun axe on ${route.name} at ${width}px; ${v.id} must pass.`,
                  "measured",
                  "P0",
                ),
              );
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          );
          if (overflow)
            r.findings.push(
              finding(
                "overflow",
                key,
                `Document wider than ${width}px`,
                "Horizontal overflow detected.",
                "Identify the overflowing element; preserve usable content.",
                "Document fits viewport without clipping.",
                "measured",
                "P0",
              ),
            );
          r.coverage.push(
            `${key}: state=${route.state}; screenshot, DOM, axe, overflow. Keyboard and interactions require separate verification.`,
          );
        } catch (e) {
          r.errors.push(`${key}: ${String(e)}`);
        } finally {
          await context.close();
        }
      }
  } catch (e) {
    r.errors.push(String(e));
  } finally {
    await browser?.close();
  }
  return r;
}
