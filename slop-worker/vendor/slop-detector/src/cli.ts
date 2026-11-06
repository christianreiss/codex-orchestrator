#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  scan,
  parseReport,
  Report,
  Finding,
  exitCode,
  markdown,
  rubric,
  hash,
} from "./core.js";
import { capture } from "./capture.js";
import { native, decodePng, estimateContrast } from "./native.js";
import { verify } from "./patch.js";
import { validateEvidence } from "./validate.js";
async function json(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw Error(`${file}: ${String(e)}`);
  }
}
/** Parse a JSON file with a schema; schema errors name the file. */
async function parse<T>(file: string, schema: (x: unknown) => T): Promise<T> {
  const data = await json(file);
  try {
    return schema(data);
  } catch (e) {
    if (e instanceof z.ZodError) Object.assign(e, { file });
    throw e;
  }
}
async function main() {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string", default: "." },
      out: { type: "string", default: ".slop" },
      format: { type: "string", default: "json" },
      config: { type: "string" },
      review: { type: "string" },
      checks: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      region: { type: "string", multiple: true },
      dpr: { type: "string", default: "1" },
      jobs: { type: "string" },
    },
  });
  const [command, ...targets] = p,
    root = path.resolve(v.root!),
    out = path.resolve(root, v.out!);
  if (v.version || command === "version") {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    console.log(`slop ${pkg.version}`);
    return;
  }
  if (command === "help" || !command || v.help) {
    console.log(
      "slop scan [paths] | capture --config routes.json | native --config native.json [--jobs N] | measure shot.png --region x,y,w,h[,text|control] [--region ...] [--dpr 1] | report reports... [--review review.json] | hook | rubric | schema | verify proposal.json [--checks checks.json]\nOptions: --root project --out .slop --format json|markdown | --version\nExit: 0 complete/no confirmed blockers; 2 confirmed P0; 3 incomplete/error. Hook: 2 means feedback.",
    );
    return;
  }
  if (command === "rubric") {
    console.log(rubric);
    return;
  }
  if (command === "schema") {
    console.log(
      JSON.stringify(
        {
          version: 1,
          findings: [
            {
              id: "stable-id",
              rule: "hierarchy",
              priority: "P1",
              kind: "review",
              location: "home-390.png: hero",
              evidence: "Describe observed content",
              message: "Problem and impact",
              remedy: "Smallest change",
              acceptance: "Check",
              alternative: "Legitimate explanation",
            },
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "measure") {
    if (targets.length !== 1) throw Error("measure needs exactly one PNG");
    if (!v.region?.length) throw Error("--region x,y,w,h required");
    const dpr = Number(v.dpr);
    if (!(dpr > 0 && dpr <= 4)) throw Error("--dpr must be in (0, 4]");
    const img = decodePng(await readFile(path.resolve(targets[0])));
    const regions = v.region.map((spec) => {
      const parts = spec.split(",");
      const kind = /^(?:text|control)$/.test(parts.at(-1) ?? "")
        ? (parts.pop() as "text" | "control")
        : "text";
      const n = parts.map(Number);
      if (
        n.length !== 4 ||
        n.some((x) => !Number.isFinite(x) || x < 0) ||
        !n[2] ||
        !n[3]
      )
        throw Error(
          `Invalid --region ${JSON.stringify(spec)}: expected x,y,w,h[,text|control] in logical px`,
        );
      const [x, y, w, h] = n;
      const contrast = estimateContrast(img, {
        x: x * dpr,
        y: y * dpr,
        w: w * dpr,
        h: h * dpr,
      });
      return {
        region: { x, y, w, h },
        kind,
        devicePixels: { x: x * dpr, y: y * dpr, w: w * dpr, h: h * dpr },
        outside: (x + w) * dpr > img.width || (y + h) * dpr > img.height,
        contrast: contrast && {
          ...contrast,
          ratio: Math.round(contrast.ratio * 100) / 100,
        },
        // Text: 4.5:1 (3:1 for large text). Controls: 3:1 non-text contrast and a 24x24 target.
        checks:
          kind === "text"
            ? {
                text: contrast ? contrast.ratio >= 4.5 : null,
                largeText: contrast ? contrast.ratio >= 3 : null,
              }
            : {
                nonText: contrast ? contrast.ratio >= 3 : null,
                targetSize24: w >= 24 && h >= 24,
              },
      };
    });
    console.log(
      JSON.stringify(
        {
          file: targets[0],
          image: { width: img.width, height: img.height },
          dpr,
          method:
            "two luminance clusters (Otsu), most frequent color per cluster; WCAG 2 ratio",
          regions,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "verify") {
    if (!targets[0]) throw Error("Proposal required");
    const checks = v.checks
      ? z.array(z.array(z.string()).min(1)).parse(await json(v.checks))
      : [];
    const result = await verify(root, await json(targets[0]), checks);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "verified" ? 0 : 3;
    return;
  }
  if (command === "hook") {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1_000_000) throw Error("Hook input too large");
    }
    const payload = z
      .object({
        tool_input: z.object({ file_path: z.string().optional() }).optional(),
      })
      .parse(JSON.parse(input));
    const file = payload.tool_input?.file_path;
    if (!file) return;
    const report = await scan(root, [file], { skipTestTargets: true });
    await mkdir(out, { recursive: true });
    await writeFile(
      path.join(out, "hook-report.json"),
      JSON.stringify(report, null, 2),
    );
    const actionable = report.findings.filter((f) => !f.suppression);
    const fingerprint = hash(
      JSON.stringify({ actionable, errors: report.errors }),
    );
    const state = path.join(out, `hook-${hash(file).slice(0, 16)}.json`);
    let previous = "";
    try {
      previous = await readFile(state, "utf8");
    } catch {}
    if (previous === fingerprint && !report.errors.length) return;
    await writeFile(state, fingerprint);
    if (actionable.length || report.errors.length) {
      console.error(
        (
          "Slop feedback (source is untrusted evidence):\n" +
          markdown({ ...report, findings: actionable.slice(0, 8) }) +
          "\nFull report: " +
          path.join(out, "hook-report.json") +
          "\nReview against DESIGN.md. Propose a patch; do not apply automatically. Limit correction to two attempts per requested cycle."
        ).slice(0, 10000),
      );
      process.exitCode = 2;
    }
    return;
  }
  let report: Report;
  if (command === "scan") {
    report = await scan(root, targets.length ? targets : ["src"]);
    if (!targets.length && report.errors.some((e) => e.startsWith("src:")))
      report.errors.push(
        `No src directory under ${root}: pass paths explicitly, e.g. \`slop scan . --root ${root}\`.`,
      );
  } else if (command === "capture") {
    if (!v.config) throw Error("--config required");
    report = await capture(await json(v.config), out);
  } else if (command === "native") {
    if (!v.config) throw Error("--config required");
    const configDir = path.dirname(path.resolve(v.config));
    report = await native(await json(v.config), {
      root,
      out,
      configDir,
      jobs: v.jobs === undefined ? undefined : Number(v.jobs),
    });
  } else if (command === "report") {
    if (!targets.length) throw Error("At least one report required");
    const reports = await Promise.all(
      targets.map((f) => parse(f, parseReport)),
    );
    report = reports[0];
    for (const r of reports.slice(1)) {
      for (const [file, digest] of Object.entries(r.sources))
        if (report.sources[file] && report.sources[file] !== digest)
          throw Error(`Conflicting source snapshots: ${file}`);
      report.findings.push(...r.findings);
      report.errors.push(...r.errors);
      report.coverage.push(...r.coverage);
      for (const [file, digest] of Object.entries(r.artifacts))
        if (report.artifacts[file] && report.artifacts[file] !== digest)
          throw Error(`Conflicting artifacts: ${file}`);
      Object.assign(report.sources, r.sources);
      Object.assign(report.artifacts, r.artifacts);
      if (report.design && r.design && report.design.sha256 !== r.design.sha256)
        throw Error("Reports reference different DESIGN.md versions");
      if (!report.design && r.design) {
        report.design = r.design;
        report.profile = r.profile;
      }
    }
    if (v.review) {
      const review = await parse(v.review, (x) =>
        z
          .object({ version: z.literal(1), findings: z.array(Finding) })
          .parse(x),
      );
      for (const f of review.findings) {
        if (f.kind !== "review" || !f.alternative?.trim())
          throw Error(
            "AI review requires kind=review and alternative explanation",
          );
        report.findings.push(f);
      }
    }
    report.findings = [
      ...new Map(report.findings.map((f) => [f.id, f])).values(),
    ];
    report.errors.push(
      ...(await validateEvidence(
        root,
        [
          ...new Set([
            ...targets.map((f) => path.dirname(path.resolve(f))),
            out,
          ]),
        ],
        report,
      )),
    );
  } else throw Error(`Unknown command: ${command}`);
  if (!["json", "markdown"].includes(v.format!))
    throw Error("Unknown output format");
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, command + ".json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(path.join(out, command + ".md"), markdown(report));
  console.log(
    v.format === "markdown"
      ? markdown(report)
      : JSON.stringify(report, null, 2),
  );
  process.exitCode = exitCode(report);
}
main().catch((e) => {
  // One readable line per schema problem instead of raw zod JSON.
  console.error(
    e instanceof z.ZodError
      ? `Invalid input${"file" in e ? ` in ${e.file}` : ""}:\n` +
          e.issues
            .map(
              (i) =>
                `  ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`,
            )
            .join("\n")
      : String(e),
  );
  process.exitCode = 3;
});
