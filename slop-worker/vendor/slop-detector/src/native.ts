import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import {
  blank,
  finding,
  loadProjectConfig,
  parseJson,
  type Finding,
  type Report,
} from "./core.js";

/** Names end up in file names, so they are restricted like capture route names. */
const name = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const unique = <T extends z.ZodType>(item: T, what: string) =>
  z
    .array(item)
    .min(1)
    .refine(
      (xs) => new Set(xs.map((x) => JSON.stringify(x))).size === xs.length,
      `${what} must be unique`,
    );
const dimension = z.number().int().min(1).max(16384);
const textScale = z.number().positive().max(4);
const dpr = z.number().positive().max(4);
const priority = z.enum(["P0", "P1", "P2"]);
const placeholders =
  /\{(platform|state|theme|width|height|textScale|dpr|output|a11y|pointerX|pointerY)\}/g;
const share = z.number().min(0).max(1);
const naFilters = [
  "state",
  "platform",
  "theme",
  "width",
  "height",
  "dpr",
  "textScale",
] as const;
/** Parallel capture runs; also accepted from --jobs. */
const jobs = z.number().int().min(1).max(16);
export const NativeConfig = z
  .object({
    /** Platform of the local capture command, e.g. linux, macos, windows, ios. */
    platform: name,
    /** argv array, executed without a shell. Supplied by the operator only. */
    command: z
      .array(z.string())
      .min(1)
      .refine((argv) => !argv.some((a) => a.includes("{scale}")), {
        message: "{scale} was replaced by {textScale} and {dpr}",
      })
      .optional(),
    /** Working directory of the command, relative to --root. */
    cwd: z.string().default("."),
    /** Extra environment for the command, same placeholders as argv (e.g. QT_SCALE_FACTOR: "{dpr}"). */
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
      .default({}),
    /** Timeout of each command run (one combination). */
    timeoutSeconds: z.number().int().min(1).max(600).default(60),
    /** Number of command runs in parallel. */
    jobs: jobs.default(1),
    /** Pointer position (logical px) for {pointerX}/{pointerY}; default outside the window. */
    pointer: z
      .object({ x: z.number(), y: z.number() })
      .strict()
      .default({ x: -1, y: -1 }),
    /** Broken-render heuristic; a share at or above a threshold is suspect. */
    renderChecks: z
      .union([
        z.literal(false),
        z
          .object({ maxBlack: share.optional(), maxUniform: share.optional() })
          .strict(),
      ])
      .default({}),
    /** States the command is asked to render. */
    states: unique(name, "states").optional(),
    requiredStates: unique(name, "requiredStates").default([
      "loaded",
      "loading",
      "empty",
      "error",
      "no-access",
      "success",
      "saving",
    ]),
    themes: unique(name, "themes").default(["light", "dark"]),
    sizes: unique(
      z.object({ width: dimension, height: dimension }).strict(),
      "sizes",
    ).default([{ width: 1200, height: 800 }]),
    /** Application text scale (accessibility text size). */
    textScales: unique(textScale, "textScales").default([1]),
    /** Device pixel ratio (e.g. QT_SCALE_FACTOR, Windows 150 % = 1.5). */
    dprs: unique(dpr, "dprs").default([1]),
    /** Required combinations that cannot exist, with a reason; every given filter must match. */
    notApplicable: z
      .array(
        z
          .object({
            reason: z.string().trim().min(1),
            state: name.optional(),
            platform: name.optional(),
            theme: name.optional(),
            width: dimension.optional(),
            height: dimension.optional(),
            dpr: dpr.optional(),
            textScale: textScale.optional(),
          })
          .strict()
          .refine((n) => naFilters.some((k) => n[k] !== undefined), {
            message:
              "notApplicable entry needs at least one filter besides reason",
          }),
      )
      .default([]),
    /** Rule id (e.g. a11y:target-size) -> priority, replacing the severity mapping. */
    severityOverrides: z.record(z.string().min(1), priority).default({}),
    /** Pre-made screenshots, paths relative to the config file. */
    screenshots: z
      .array(
        z
          .object({
            file: z.string().min(1),
            state: name,
            theme: name,
            width: dimension,
            height: dimension,
            textScale: textScale.default(1),
            dpr: dpr.default(1),
            platform: name.optional(),
            a11y: z.string().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
    /** Directories (relative to the config file) of PNGs named like captures. */
    screenshotDirs: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine((c) => !c.command || c.states, {
    message: "states is required when command is set",
    path: ["states"],
  });
export type NativeConfig = z.infer<typeof NativeConfig>;

/** Accessibility adapter contract: an export from an external AX/AT-SPI/UIA tool. */
export const A11yExport = z
  .object({
    tool: z.string().min(1),
    findings: z
      .array(
        z
          .object({
            rule: z.string().min(1),
            target: z.string().min(1),
            message: z.string().min(1),
            severity: z.enum(["critical", "serious", "moderate", "minor"]),
            evidence: z.string().min(1).optional(),
            /** Element bounds in logical pixels; requests a contrast estimate. */
            rect: z
              .object({
                x: z.number().min(0),
                y: z.number().min(0),
                w: z.number().positive(),
                h: z.number().positive(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();

const severityPriority = {
  critical: "P0",
  serious: "P0",
  moderate: "P1",
  minor: "P2",
} as const;

/** Replace the priority of findings whose rule id has an override. */
export function applySeverityOverrides(
  findings: Finding[],
  overrides: Record<string, "P0" | "P1" | "P2">,
): Finding[] {
  return findings.map((f) =>
    Object.hasOwn(overrides, f.rule)
      ? { ...f, priority: overrides[f.rule] }
      : f,
  );
}

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const maxArtifact = 200_000_000,
  maxA11y = 5_000_000,
  maxDecoded = 256_000_000;

interface Combo {
  platform: string;
  state: string;
  theme: string;
  width: number;
  height: number;
  textScale: number;
  dpr: number;
}
const keyOf = (c: Combo) =>
  `${c.platform}|${c.state}|${c.theme}|${c.width}x${c.height}|${c.dpr}|${c.textScale}`;
const describe = (c: Combo) =>
  `platform=${c.platform} state=${c.state} theme=${c.theme} size=${c.width}x${c.height} dpr=${c.dpr} textScale=${c.textScale}`;
const variantOf = (c: Combo) =>
  `${c.theme} ${c.width}x${c.height} dpr${c.dpr} text${c.textScale}`;
/** Captured screenshot name: {platform}-{state}-{theme}-{w}x{h}@{dpr}x-t{textScale}.png */
export const captureName = (c: Combo) =>
  `${c.platform}-${c.state}-${c.theme}-${c.width}x${c.height}@${c.dpr}x-t${c.textScale}.png`;
const a11yPathOf = (png: string) => png.replace(/\.png$/, ".a11y.json");
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** Validate the PNG signature and IHDR; return dimensions and the bytes. */
async function readPng(file: string) {
  const s = await stat(file);
  if (!s.isFile()) throw Error("not a regular file");
  if (s.size === 0) throw Error("empty file (0 bytes)");
  if (s.size > maxArtifact) throw Error("file too large");
  const bytes = await readFile(file);
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(pngSignature) ||
    bytes.toString("latin1", 12, 16) !== "IHDR"
  )
    throw Error("not a PNG file");
  return {
    bytes,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

export interface Pixels {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}
/** Decode 8-bit gray, gray+alpha, RGB or RGBA non-interlaced PNGs; anything else throws. */
export function decodePng(bytes: Buffer): Pixels {
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20),
    depth = bytes[24],
    color = bytes[25],
    interlace = bytes[28];
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
    color
  ];
  if (depth !== 8 || !channels || interlace !== 0)
    throw Error(
      `unsupported PNG format (bit depth ${depth}, color type ${color}, interlace ${interlace}); only 8-bit gray/RGB/RGBA non-interlaced`,
    );
  const stride = width * channels,
    expected = (stride + 1) * height;
  if (expected > maxDecoded) throw Error("PNG too large to decode");
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at),
      type = bytes.toString("latin1", at + 4, at + 8);
    if (type === "IDAT") idat.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  if (raw.length !== expected) throw Error("truncated PNG image data");
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)],
      src = y * (stride + 1) + 1,
      row = y * stride;
    if (filter > 4) throw Error(`invalid PNG filter ${filter}`);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? data[row + i - channels] : 0,
        b = y ? data[row - stride + i] : 0,
        c = y && i >= channels ? data[row - stride + i - channels] : 0,
        x = raw[src + i];
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      data[row + i] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}

const linear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: number[]) =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const luma = (r: number, g: number, b: number) =>
  Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
const hex = (rgb: number[]) =>
  "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

/**
 * Estimate text contrast in a device-pixel rectangle: split its pixels into two
 * luminance clusters (Otsu threshold), take the most frequent color of each
 * cluster and return their WCAG contrast ratio. Alpha is ignored. Returns null
 * when the rectangle is empty or holds essentially one color.
 */
export function estimateContrast(
  img: Pixels,
  rect: { x: number; y: number; w: number; h: number },
) {
  const x0 = Math.max(0, Math.floor(rect.x)),
    y0 = Math.max(0, Math.floor(rect.y)),
    x1 = Math.min(img.width, Math.ceil(rect.x + rect.w)),
    y1 = Math.min(img.height, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return null;
  const colors = new Map<number, number>(),
    histogram = new Array<number>(256).fill(0);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const at = (y * img.width + x) * img.channels,
        gray = img.channels < 3;
      const r = img.data[at],
        g = gray ? r : img.data[at + 1],
        b = gray ? r : img.data[at + 2];
      const packed = (r << 16) | (g << 8) | b;
      colors.set(packed, (colors.get(packed) ?? 0) + 1);
      histogram[luma(r, g, b)]++;
    }
  const total = (x1 - x0) * (y1 - y0);
  let sum = 0;
  histogram.forEach((n, i) => (sum += n * i));
  let best = -1,
    threshold = 0,
    weight = 0,
    sumLow = 0;
  for (let t = 0; t < 256; t++) {
    weight += histogram[t];
    sumLow += t * histogram[t];
    if (!weight || weight === total) continue;
    const between =
      weight *
      (total - weight) *
      (sumLow / weight - (sum - sumLow) / (total - weight)) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  const sides = [0, 1].map(() => ({ color: 0, count: 0, size: 0 }));
  for (const [packed, count] of colors) {
    const side =
      sides[
        luma(packed >> 16, (packed >> 8) & 0xff, packed & 0xff) > threshold
          ? 1
          : 0
      ];
    side.size += count;
    if (count > side.count) {
      side.count = count;
      side.color = packed;
    }
  }
  if (sides.some((s) => s.size < Math.max(4, total * 0.005))) return null;
  const [dark, light] = sides.map((s) => [
    s.color >> 16,
    (s.color >> 8) & 0xff,
    s.color & 0xff,
  ]);
  return {
    ratio: (luminance(light) + 0.05) / (luminance(dark) + 0.05),
    dark: hex(dark),
    light: hex(light),
  };
}

function tail(text: string | Buffer | null | undefined) {
  const s = String(text ?? "")
    .replace(/[^\x20-\x7e\n\t]/g, "?")
    .trim();
  return s.length > 500 ? "..." + s.slice(-500) : s;
}

/**
 * Share of opaque pure-black (#000000) pixels, of fully transparent (alpha 0)
 * pixels and of the most frequent color (alpha ignored). Counts runs of equal
 * pixels, so flat UI screenshots stay cheap.
 */
function renderStats(img: Pixels) {
  const { data, channels } = img,
    total = img.width * img.height,
    counts = new Map<number, number>();
  const alpha = channels === 2 || channels === 4 ? channels - 1 : -1;
  let black = 0,
    transparent = 0,
    run = -1,
    length = 0;
  for (let i = 0, at = 0; i < total; i++, at += channels) {
    const r = data[at],
      packed =
        channels < 3
          ? (r << 16) | (r << 8) | r
          : (r << 16) | (data[at + 1] << 8) | data[at + 2];
    if (alpha >= 0 && data[at + alpha] === 0) transparent++;
    else if (packed === 0) black++;
    if (packed === run) length++;
    else {
      if (length) counts.set(run, (counts.get(run) ?? 0) + length);
      run = packed;
      length = 1;
    }
  }
  if (length) counts.set(run, (counts.get(run) ?? 0) + length);
  let color = 0,
    most = 0;
  for (const [packed, count] of counts)
    if (count > most) {
      most = count;
      color = packed;
    }
  return {
    black: black / total,
    transparent: transparent / total,
    uniform: most / total,
    color: hex([color >> 16, (color >> 8) & 0xff, color & 0xff]),
  };
}
const percent = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Keep only the last bytes of a stream: enough for an error message. */
const maxCapture = 64 * 1024;
function collect(stream: NodeJS.ReadableStream | null) {
  let kept = Buffer.alloc(0);
  stream?.on("data", (b: Buffer) => {
    kept = Buffer.concat([kept, b]);
    if (kept.length > maxCapture) kept = kept.subarray(-maxCapture);
  });
  return () => kept;
}

/** Run one capture without a shell; resolves with a failure text or "". */
function runCapture(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
): Promise<{ failure: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ failure: String(e), stderr: "" });
      return;
    }
    collect(child.stdout);
    const stderr = collect(child.stderr);
    let done = false,
      timedOut = false,
      grace: NodeJS.Timeout | undefined;
    const finish = (failure: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ failure, stderr: tail(stderr()) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    const outcome = (code: number | null, signal: string | null) =>
      timedOut
        ? `timed out after ${timeoutSeconds}s`
        : signal
          ? `killed by ${signal}`
          : code !== 0
            ? `exit ${code}`
            : "";
    child.on("error", (e) => finish(String(e)));
    child.on("close", (code, signal) => finish(outcome(code, signal)));
    // A grandchild holding the pipes open must not keep the run alive.
    child.on("exit", (code, signal) => {
      grace = setTimeout(() => finish(outcome(code, signal)), 1000);
    });
  });
}

/** Run tasks with at most `limit` in flight; results keep the input order. */
function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T>[] {
  let next = 0;
  const starts: ((v: void) => void)[] = [];
  const results = tasks.map((task, i) =>
    new Promise<void>((start) => {
      starts[i] = start;
    }).then(task),
  );
  const launch = (): void => {
    const i = next++;
    if (i < tasks.length) {
      starts[i]();
      results[i].finally(launch).catch(() => {});
    }
  };
  for (let k = 0; k < Math.min(limit, tasks.length); k++) launch();
  return results;
}

/**
 * Parse a captureName back into a combination. Names may contain "-", so theme
 * and state come from the config vocabulary; the shortest platform wins.
 */
function parseCaptureName(
  file: string,
  themes: string[],
  states: string[],
): Combo | undefined {
  const m = /^(.+)-(\d+)x(\d+)@(\d+(?:\.\d+)?)x-t(\d+(?:\.\d+)?)\.png$/.exec(
    file,
  );
  if (!m) return;
  const [, prefix, w, h, d, t] = m;
  let best: Combo | undefined;
  for (const theme of themes)
    for (const state of states) {
      const suffix = `-${state}-${theme}`;
      if (!prefix.endsWith(suffix)) continue;
      const platform = prefix.slice(0, -suffix.length);
      if (!name.safeParse(platform).success) continue;
      const combo = {
        platform,
        state,
        theme,
        width: Number(w),
        height: Number(h),
        dpr: Number(d),
        textScale: Number(t),
      };
      if (
        captureName(combo) === file &&
        dimension.safeParse(combo.width).success &&
        dimension.safeParse(combo.height).success &&
        dpr.safeParse(combo.dpr).success &&
        textScale.safeParse(combo.textScale).success &&
        (!best || platform.length < best.platform.length)
      )
        best = combo;
    }
  return best;
}

export interface NativeOptions {
  /** Project root; the command's cwd is relative to it. */
  root: string;
  /** Output directory for captures and the report; artifact keys are relative to it. */
  out: string;
  /** Directory of the config file; imported screenshot paths are relative to it. */
  configDir: string;
  /** Parallel capture runs (--jobs); overrides the config. */
  jobs?: number;
}

/**
 * Build native screenshot evidence from a state x theme x size x dpr x text-scale
 * matrix. The command comes only from the operator's config and runs as the
 * local user without operating-system isolation.
 */
export async function native(
  config: unknown,
  { root, out, configDir, jobs: jobsOption }: NativeOptions,
): Promise<Report> {
  const c = NativeConfig.parse(config),
    r = blank();
  if (jobsOption !== undefined && !jobs.safeParse(jobsOption).success)
    throw Error("--jobs must be an integer from 1 to 16");
  const parallel = jobsOption ?? c.jobs;
  const render = c.renderChecks && {
    maxBlack: c.renderChecks.maxBlack ?? 0.1,
    maxUniform: c.renderChecks.maxUniform ?? 0.98,
  };
  await mkdir(out, { recursive: true });
  /** Artifact keys: POSIX path relative to the out dir (where native.json is written). */
  const artifactKey = (file: string) =>
    path.relative(out, file).split(path.sep).join("/");
  const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const shots = new Map<string, string>();
  const a11yPlatforms = new Set<string>(),
    a11yInvalid = new Set<string>();

  async function importA11y(
    file: string,
    png: string,
    pixels: () => Pixels | Error,
    combo: Combo,
  ) {
    if ((await stat(file)).size > maxA11y) throw Error("a11y export too large");
    const text = await readFile(file);
    const data = A11yExport.parse(parseJson(text.toString("utf8")));
    r.artifacts[artifactKey(file)] = digest(text);
    a11yPlatforms.add(combo.platform);
    const label = path.basename(png),
      variant = variantOf(combo),
      context = { platform: combo.platform, variant, state: combo.state };
    let estimates = 0;
    const notes: string[] = [];
    for (const a of data.findings) {
      r.findings.push({
        ...finding(
          `a11y:${a.rule}`,
          `${label}: ${a.target}`,
          a.evidence ?? a.message,
          a.message,
          `Resolve ${a.rule} on ${a.target}: ${a.message}`,
          `Re-export ${data.tool} data for state ${combo.state} (${variant}) on ${combo.platform}; ${a.rule} must no longer be reported for ${a.target}.`,
          "measured",
          severityPriority[a.severity],
        ),
        ...context,
      });
      if (!a.rect) continue;
      const img = pixels();
      if (img instanceof Error) {
        notes.push(`contrast not estimated: ${img.message}`);
        continue;
      }
      const { x, y, w, h } = a.rect;
      const est = estimateContrast(img, {
        x: x * combo.dpr,
        y: y * combo.dpr,
        w: w * combo.dpr,
        h: h * combo.dpr,
      });
      if (!est) {
        notes.push(
          `contrast not estimated for ${a.target} (rect outside image or single color)`,
        );
        continue;
      }
      estimates++;
      if (est.ratio >= 4.5) continue;
      const ratio = est.ratio.toFixed(2);
      r.findings.push({
        ...finding(
          "contrast-estimate",
          `${label}: ${a.target}`,
          `Estimated contrast ${ratio}:1 between ${est.dark} and ${est.light} in rect x=${x} y=${y} w=${w} h=${h} (logical px)`,
          `Estimated text contrast ${ratio}:1 is below 4.5:1.`,
          "Use theme text and background roles that reach at least 4.5:1 (3:1 for large text).",
          `Measure ${a.target} in state ${combo.state} (${variant}) on ${combo.platform} with a contrast checker; text reaches 4.5:1.`,
          "review",
          "P1",
        ),
        alternative:
          "Pixel estimate: large or bold text needs only 3:1, and icons, images, anti-aliasing or a loose rect can skew the dominant colors.",
        ...context,
      });
    }
    return [
      `${data.tool}: ${data.findings.length} accessibility findings`,
      ...(estimates ? [`${estimates} contrast estimates`] : []),
      ...notes,
    ].join("; ");
  }

  /** Validate a screenshot, record artifacts and a11y data, count it for coverage. */
  async function accept(
    combo: Combo,
    file: string,
    label: string,
    a11y: string | undefined,
    origin: "capture" | "imported",
  ) {
    let png;
    try {
      png = await readPng(file);
    } catch (e) {
      r.errors.push(
        `${label}: ${origin === "capture" ? "invalid capture output" : "invalid imported screenshot"} (${missing(e) ? "missing file" : (e as Error).message})`,
      );
      return;
    }
    r.artifacts[artifactKey(file)] = digest(png.bytes);
    const w = combo.width * combo.dpr,
      h = combo.height * combo.dpr;
    if (Math.abs(png.width - w) >= 1 || Math.abs(png.height - h) >= 1) {
      r.errors.push(
        `${label}: PNG is ${png.width}x${png.height}, expected ${Math.round(w)}x${Math.round(h)} (${combo.width}x${combo.height} at dpr ${combo.dpr})`,
      );
      return;
    }
    const key = keyOf(combo),
      previous = shots.get(key);
    if (previous) {
      r.errors.push(
        `Duplicate screenshot for ${describe(combo)}: ${previous} and ${label}`,
      );
      return;
    }
    shots.set(key, label);
    // Decode at most once per PNG, shared by the render check and contrast estimates.
    let decoded: Pixels | Error | undefined;
    const pixels = () => {
      if (!decoded)
        try {
          decoded = decodePng(png.bytes);
        } catch (e) {
          decoded = e as Error;
        }
      return decoded;
    };
    const notes: string[] = [];
    if (render) {
      const img = pixels();
      if (img instanceof Error)
        notes.push(`render check skipped: ${img.message}`);
      else checkRender(img, combo, artifactKey(file));
    }
    if (a11y)
      try {
        notes.push(await importA11y(a11y, file, pixels, combo));
      } catch (e) {
        r.errors.push(
          `${path.basename(a11y)}: ${missing(e) ? "missing a11y file" : `invalid a11y export: ${tail(e instanceof z.ZodError ? z.prettifyError(e).replace(/\s*\n\s*/g, "; ") : String(e))}`}`,
        );
        a11yInvalid.add(combo.platform);
        notes.push("a11y export rejected, see errors");
      }
    r.coverage.push(
      `${label}: ${describe(combo)}; ${origin} PNG ${png.width}x${png.height}${notes.map((n) => `; ${n}`).join("")}.`,
    );
  }

  /**
   * Flag captures that are mostly pure black, transparent or one color (broken
   * offscreen/dpr render). Opaque black and alpha-0 pixels share the maxBlack
   * threshold, but are named separately.
   */
  function checkRender(img: Pixels, combo: Combo, location: string) {
    if (!render) return;
    const stats = renderStats(img),
      empty = stats.black + stats.transparent,
      black = empty >= render.maxBlack,
      uniform = stats.uniform >= render.maxUniform;
    if (!black && !uniform) return;
    const variant = variantOf(combo),
      clear = stats.transparent > 0,
      what =
        stats.transparent > stats.black
          ? "fully transparent (alpha 0)"
          : "pure black",
      covered = clear
        ? `Pure black #000000 covers ${percent(stats.black)} and fully transparent (alpha 0) pixels cover ${percent(stats.transparent)} of ${img.width}x${img.height} px (together ${percent(empty)}, threshold ${percent(render.maxBlack)})`
        : `Pure black #000000 covers ${percent(stats.black)} of ${img.width}x${img.height} px (threshold ${percent(render.maxBlack)})`;
    r.findings.push({
      ...finding(
        "render-suspect",
        location,
        `${covered}; the most frequent color ${stats.color} covers ${percent(stats.uniform)} (threshold ${percent(render.maxUniform)}).`,
        black
          ? `Screenshot may be a broken render: ${percent(empty)} is ${clear && stats.black > 0 ? "pure black or fully transparent" : what} (cropped, offset or unpainted area).`
          : `Screenshot may be a broken render: ${percent(stats.uniform)} is the single color ${stats.color} (blank window).`,
        `Check the renderer at dpr ${combo.dpr}: with an offscreen platform plus a scale factor (e.g. QT_QPA_PLATFORM=offscreen, QT_SCALE_FACTOR=${combo.dpr}) the window must fill all ${img.width}x${img.height} device pixels without black margins or a layout shifted to the top left${clear ? "; transparent pixels mean nothing painted there (missing window background or a grab of an unpainted area), so capture an opaque window" : ""}; then recapture.`,
        `Recapture state ${combo.state} (${variant}) on ${combo.platform}: pure black${clear ? " plus transparent" : ""} below ${percent(render.maxBlack)} and no single color at or above ${percent(render.maxUniform)}, or confirm by inspection that the surface is intentional.`,
        "review",
        "P1",
      ),
      alternative:
        "An intentionally black (OLED) theme, a dark media or canvas surface, or a deliberately blank state (splash, empty canvas) can legitimately be mostly black or one color.",
      platform: combo.platform,
      variant,
      state: combo.state,
    });
  }

  if (c.command && c.states) {
    const cwd = path.resolve(root, c.cwd),
      command = c.command,
      combos: Combo[] = [];
    for (const state of c.states)
      for (const theme of c.themes)
        for (const { width, height } of c.sizes)
          for (const dpr of c.dprs)
            for (const textScale of c.textScales)
              combos.push({
                platform: c.platform,
                state,
                theme,
                width,
                height,
                textScale,
                dpr,
              });
    const runs = pool(
      combos.map((combo) => async () => {
        const output = path.join(out, captureName(combo)),
          a11y = a11yPathOf(output);
        const values: Record<string, string> = {
          platform: combo.platform,
          state: combo.state,
          theme: combo.theme,
          width: String(combo.width),
          height: String(combo.height),
          textScale: String(combo.textScale),
          dpr: String(combo.dpr),
          output,
          a11y,
          pointerX: String(c.pointer.x),
          pointerY: String(c.pointer.y),
        };
        const fill = (s: string) =>
          s.replace(placeholders, (_, k: string) => values[k]);
        // A stale file from an earlier run must never count as evidence.
        await rm(output, { force: true });
        await rm(a11y, { force: true });
        const env = { ...process.env };
        for (const [key, value] of Object.entries(c.env))
          env[key] = fill(value);
        const run = await runCapture(
          command.map(fill),
          cwd,
          env,
          c.timeoutSeconds,
        );
        return { combo, output, a11y, ...run };
      }),
      parallel,
    );
    // Handle results in combination order, not completion order.
    for (const pending of runs) {
      const { combo, output, a11y, failure, stderr } = await pending,
        label = path.basename(output);
      if (failure) {
        r.errors.push(
          `${label}: capture command failed (${failure})${stderr ? `: ${stderr}` : ""}`,
        );
        continue;
      }
      const hasA11y = await stat(a11y).then(
        () => true,
        () => false,
      );
      await accept(combo, output, label, hasA11y ? a11y : undefined, "capture");
    }
  }

  const platforms = new Set([
    c.platform,
    ...c.screenshots.map((s) => s.platform ?? c.platform),
  ]);
  for (const shot of c.screenshots)
    await accept(
      {
        platform: shot.platform ?? c.platform,
        state: shot.state,
        theme: shot.theme,
        width: shot.width,
        height: shot.height,
        textScale: shot.textScale,
        dpr: shot.dpr,
      },
      path.resolve(configDir, shot.file),
      shot.file,
      shot.a11y && path.resolve(configDir, shot.a11y),
      "imported",
    );

  const vocabulary = [...new Set([...(c.states ?? []), ...c.requiredStates])];
  for (const dir of c.screenshotDirs) {
    const abs = path.resolve(configDir, dir);
    let names: string[];
    try {
      names = (await readdir(abs)).sort();
    } catch (e) {
      r.errors.push(
        `screenshotDirs ${dir}: ${missing(e) ? "missing directory" : (e as Error).message}`,
      );
      continue;
    }
    const unmatched: string[] = [];
    for (const file of names.filter((n) => n.endsWith(".png"))) {
      const combo = parseCaptureName(file, c.themes, vocabulary);
      if (!combo) {
        unmatched.push(file);
        continue;
      }
      platforms.add(combo.platform);
      const png = path.join(abs, file),
        a11y = a11yPathOf(png);
      const hasA11y = await stat(a11y).then(
        (s) => s.isFile(),
        () => false,
      );
      await accept(
        combo,
        png,
        path.posix.join(dir.split(path.sep).join("/"), file),
        hasA11y ? a11y : undefined,
        "imported",
      );
    }
    if (unmatched.length)
      r.coverage.push(
        `screenshotDirs ${dir}: ${unmatched.length} PNG not imported (name is not {platform}-{state}-{theme}-{w}x{h}@{dpr}x-t{textScale}.png with a configured state and theme): ${unmatched.join(", ")}`,
      );
  }

  const used = new Set<number>();
  /** " state=x theme=y ..." for the filters an entry sets, in a fixed order. */
  const filters = (n: NativeConfig["notApplicable"][number], skip: string[]) =>
    naFilters
      .filter((k) => n[k] !== undefined && !skip.includes(k))
      .map((k) => ` ${k}=${n[k]}`)
      .join("");
  for (const platform of platforms) {
    let present = 0,
      required = 0,
      skipped = 0;
    const listed = new Set<number>();
    for (const state of c.requiredStates)
      for (const theme of c.themes)
        for (const { width, height } of c.sizes)
          for (const dpr of c.dprs)
            for (const textScale of c.textScales) {
              const combo = {
                platform,
                state,
                theme,
                width,
                height,
                textScale,
                dpr,
              };
              const na = c.notApplicable.findIndex((n) =>
                naFilters.every((k) => n[k] === undefined || n[k] === combo[k]),
              );
              if (na >= 0) {
                skipped++;
                used.add(na);
                listed.add(na);
              } else {
                required++;
                if (shots.has(keyOf(combo))) present++;
                else r.errors.push(`Missing screenshot: ${describe(combo)}`);
              }
            }
    for (const i of listed) {
      const n = c.notApplicable[i];
      r.coverage.push(
        `Not applicable: platform=${platform}${filters(n, ["platform"])} (${n.reason})`,
      );
    }
    const plural = (k: number, word: string, many: string) =>
      `${k} ${k === 1 ? word : many}`;
    r.coverage.push(
      `${platform}: ${present}/${required} required screenshots${skipped ? `, ${plural(skipped, "not applicable combination", "not applicable combinations")} (${plural(listed.size, "entry", "entries")})` : ""}`,
    );
    if (!a11yPlatforms.has(platform))
      r.coverage.push(
        `${platform}: accessibility not measured (${a11yInvalid.has(platform) ? "a11y export rejected, see errors" : "no a11y export"}); review it with the platform's accessibility inspector.`,
      );
  }
  c.notApplicable.forEach((n, i) => {
    if (!used.has(i))
      r.errors.push(
        `notApplicable entry matches no required screenshot:${filters(n, [])}`,
      );
  });
  // Project-wide slop.json overrides apply first; native.json wins per rule.
  const project = await loadProjectConfig(root);
  if (project.error) r.errors.push(project.error);
  r.findings = applySeverityOverrides(r.findings, {
    ...project.config.severityOverrides,
    ...c.severityOverrides,
  });
  r.coverage.push(
    "Native capture: screenshots, imported a11y exports and pixel contrast estimates only. Keyboard operation, focus order, zoom and interactions require separate verification.",
  );
  return r;
}
