# Slop Detector

Local UI/UX feedback for coding agents. The tool reports observed defects and contextual review signals, with locations, remedies and acceptance checks. It does not detect AI authorship. The research collection starts at [00-README.md](00-README.md).

## Run

Requires Node 22+, npm and Git (for patch verification).

```sh
npm ci
npm run build
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium
node dist/cli.js scan tests/fixtures --format markdown
node dist/cli.js rubric
```

Use `node /absolute/path/to/dist/cli.js` from another project, or `npm link` to expose `slop`. No API key or additional model is needed. `scan` defaults to `src`; pass files or directories explicitly (for example `Sources` in Swift packages, or `.`). Without `src` the scan is incomplete and says so. `--root` selects the project. Output defaults to its `.slop/` directory; add that directory to the target project's ignore file.

Exit codes: **0** completed without confirmed blockers, **2** measured P0 defects, **3** incomplete checks or invalid input. Source signals alone never block CI. A zero source-scan exit does not mean browser or contextual review passed. Invalid input files are reported as one line per problem (`path.in.document: message`) with the file name. `slop --version` (`-V`) prints the release version to pin in reports.

## Supported sources

| Language | Extensions | Native rules |
|---|---|---|
| Web | `.ts(x) .js(x) .html .css .scss .vue .svelte .astro .mdx` | Tailwind/CSS patterns |
| Swift (SwiftUI/UIKit) | `.swift` | gradients, materials/blur, raw `Color(red:)`, disabled focus, empty `Button` actions |
| QML | `.qml` | `gradient:`, shadow/blur effects, raw `color: "#…"`, `activeFocusOnTab: false`, empty `onClicked` |
| C++ (Qt) | `.cpp .cc .cxx .h .hh .hpp .hxx` | `QLinearGradient`/QSS gradients, `QGraphics*Effect`, raw `QColor`, `Qt::NoFocus`, empty `connect` lambdas |

All languages share `placeholder`; native files check marketing copy only inside string literals and font names only as quoted literals, so identifiers such as `Interval` or `Unlock()` stay quiet. Native raw-color signals are skipped in files whose name contains `theme`, `palette`, `color(s)`, `token(s)`, `look`, `appearance` or `style(s)`, where token definitions belong. Scans skip `.build`, `.swiftpm`, `DerivedData`, `Pods`, `Carthage`, `build-*`/`cmake-build-*` shadow builds and generated `moc_*`/`qrc_*` sources. Use `// slop-ok: <reason>` for exceptions.

**Skipped sources.** Directory scans skip test and fixture code: directories named `test`, `tests`, `__tests__`, `testdata`, `fixture(s)`, `__fixtures__` or ending in `Tests` (Xcode targets), and files such as `FooTests.cpp`, `FooTest.swift`, `foo.test.ts`, `foo.spec.ts`, `test_foo.cpp`, `foo_test.cpp` or `FixtureImageProvider.cpp`. They also skip vendored directories (`vendor(s)`, `third_party`, `thirdparty`, `3rdparty`), minified `*.min.js`/`*.min.css`, Qt Linguist `.ts` translations (detected by their XML header) and lines longer than 1000 characters. A `Skipped: …` coverage line reports the count for each reason. Targets you name explicitly are never skipped by name (`scan tests/fixtures` works); only entries found beneath them are. The edit hook is the exception and stays quiet for test and fixture files.

**Project config.** An optional `slop.json` at the scan root is validated strictly; unknown keys or invalid values make the scan incomplete (exit 3): `{"exclude": ["generated/**", "**/*.g.qml"], "tokenFiles": ["desktop/quick/style/**"], "includeTests": false, "severityOverrides": {"raw-token": "P2"}}`. Globs are root-relative with `/` separators and support `**`, `*` and `?`. `exclude` skips matching files and directories, including explicit targets. `tokenFiles` silences `raw-token` in matching files of any language. `includeTests: true` scans test and fixture code. `severityOverrides` changes the priority of findings by rule id; `scopedOverrides: [{"paths": ["website-dynamic/**"], "rules": ["gradient"], "priority": "P2"}]` does so per path (rules optional, later entries win); scan findings remain review signals and never block CI.

**Rule semantics.** Native `raw-token` fires only for literal colors (`Qt.rgba(1, 1, 1, 0.2)`, `Color(red: 0.4, …)`, `QColor::fromRgbF(0.3, …)`, `"#hex"`), not for colors computed from theme values (`Qt.rgba(Theme.text.r, …)`, `Qt.alpha(Theme.accent, 0.1)`). `copy` flags "Unlock" only in marketing phrases ("Unlock your potential"), not actions ("Unlock PDF"); copy in a short label (fewer than four words) is P2, longer copy P1. Native `type-default` flags a default font only as the primary family; fallbacks later in a list (`"SF Pro Text", "Inter"`, also across line breaks) stay quiet. Native `focus` asks whether the control is reachable by keyboard another way before keeping it in the tab order. Native `gradient` treats functional fades (scroll-edge masks, highlight fades) as legitimate and asks for a DESIGN.md rationale only for decorative fills; in QML only literal gradients (`gradient: Gradient {…}`, presets) are flagged, not a passed-through property (`gradient: root.fillGradient`).

Rules are line-based: SwiftUI modifier chains or QML properties split across lines (for example `font.capitalization` plus `letterSpacing`) are not combined. Qt Designer `.ui`, `.qss` and Objective-C++ files are not scanned. Non-Qt C++ receives essentially only the shared copy, font and placeholder signals.

## Automatic edit feedback

Merge this entry into the target project's `.claude/settings.json`, replacing the absolute tool path:

```json
{"hooks":{"PostToolUse":[{"matcher":"Edit|Write","hooks":[{"type":"command","command":"node /absolute/path/to/dist/cli.js hook --root \"$CLAUDE_PROJECT_DIR\"","timeout":15}]}]}}
```

The hook reads `tool_input.file_path`, checks only that file, writes the full report, and returns up to eight findings / 10,000 characters on stderr with exit 2. Identical findings for the same file are suppressed until they change; remove `.slop/hook-*.json` to reset feedback. Missing files and malformed input are explicit errors. Source scans exclude dependency/build directories and symlinks and enforce file count/size bounds.

This is a Claude Code PostToolUse adapter, not an undo mechanism: the triggering edit already happened. Other agents can invoke `scan` after edits; automatic integration depends on their host. Shell edits and tools without `file_path` need an explicit scan. Existing Bash templates remain standalone and unchanged.

The hook contract follows the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks). A live Claude session was not part of the automated acceptance test.

## Browser review at milestones

Start the target app yourself. Provide explicit URLs for reproducible fixture states:

```json
{"routes":[{"name":"inventory-loaded","url":"http://localhost:3000/inventory?fixture=loaded","state":"loaded"}],"requiredStates":["loaded","loading","empty","error","no-access","success","saving"],"widths":[320,390,768,1440]}
```

```sh
slop capture --config routes.json
slop report .slop/scan.json .slop/capture.json --review review.json --format markdown
```

Missing required states make capture incomplete. Configure required states deliberately for the flow; declaring a state labels the fixture, it does not prove the app entered that state. Each route/width gets PNG, DOM HTML and raw axe evidence. Failed HTTP navigation and browser failures never pass. Only navigate trusted target apps: their page scripts run in the browser. Capture does not click destructive actions or create fixture data.

Axe checks and overflow are automated. Keyboard operation, zoom, dark mode, motion, interactions and truthful state fixtures still need explicit review/tests. [Playwright's accessibility guidance](https://playwright.dev/docs/accessibility-testing) explains the limits of automated checks.

## Native screenshots (Swift, QML/Qt)

`slop native --config native.json` builds evidence for native apps from a state × theme × size × dpr × textScale matrix:

```json
{"platform":"linux","command":["./build/quick_preview","--state","{state}","--theme","{theme}","--size","{width}x{height}","--text-scale","{textScale}","--capture","{output}","--a11y","{a11y}"],"env":{"QT_QPA_PLATFORM":"offscreen","QT_SCALE_FACTOR":"{dpr}"},"timeoutSeconds":90,"states":["ready","empty","error"],"requiredStates":["ready","empty","error","loading"],"themes":["light","dark"],"sizes":[{"width":1200,"height":800},{"width":640,"height":480}],"dprs":[1,1.5],"textScales":[1,2],"notApplicable":[{"state":"loading","reason":"no liveSource stub in the Qt preview yet"}]}
```

The optional `command` (argv array, no shell, cwd relative to `--root`, `timeoutSeconds` per run, default 60, max 600) runs for every `states` × `themes` × `sizes` × `dprs` × `textScales` combination. Placeholders `{platform} {state} {theme} {width} {height} {dpr} {textScale} {output} {a11y}` are substituted in arguments and in `env` values. It must write `{output}`, named `{platform}-{state}-{theme}-{w}x{h}@{dpr}x-t{textScale}.png` in `--out`, at `width*dpr × height*dpr` pixels. A non-zero exit, timeout, missing, empty, non-PNG or wrong-size file is an error, never a pass. The command comes only from your config and runs as your local user **without operating-system isolation**.

`screenshots` imports PNGs made on other hosts or VMs (paths relative to the config file; `platform`, `dpr`, `textScale` and an optional `a11y` file per entry). Every PNG and a11y file is listed in `artifacts` with its sha256, keyed by a POSIX path relative to `--out` (imports outside it start with `../`); `report` checks those hashes. Findings should cite the artifact key; a bare file name is accepted when exactly one artifact has that name. A relative `--out` is resolved against `--root` (`--root w --out w` writes to `w/w`); pass an absolute path to avoid surprises. Sizes are the content (window client) size the capture tool renders, not the outer window including title bar and toolbar chrome.

Every platform present needs `requiredStates` × themes × sizes × dprs × textScales. Each missing combination is reported as `Missing screenshot: platform=… state=… …` (exit 3), with a summary such as `linux: 18/20 required screenshots, 4 not applicable`. `notApplicable: [{state, reason, platform?, theme?}]` excludes combinations deliberately and stays visible in coverage; an entry that matches nothing is an error.

Accessibility is an import contract, not a built-in AX/AT-SPI/UIA client: `{a11y}` or an imported `a11y` file may contain `{"tool", "findings": [{"rule", "target", "message", "severity": "critical|serious|moderate|minor", "evidence"?, "rect"?: {x, y, w, h}}]}`. Entries become measured `a11y:<rule>` findings (critical/serious P0, moderate P1, minor P2). Override per rule with `severityOverrides` in `native.json` or project-wide in `slop.json` (`native.json` wins). A `rect` (logical px) also gets a pixel contrast estimate from the PNG (8-bit gray/RGB/RGBA, non-interlaced); below 4.5:1 it adds a P1 `contrast-estimate` finding of kind `review`, since it is an estimate, not a measurement. An entry emitted only to request an estimate is still an `a11y:` finding; give it `severity: "minor"`. Platforms without a11y data are reported as not measured. Keyboard operation, focus order, zoom, motion and interactions still need manual review or tests.

**Pixel checks.** `slop measure shot.png --region x,y,w,h[,text|control] [--region …] [--dpr 1.5]` prints JSON per region (logical px, scaled by dpr): the two dominant colors and their WCAG ratio. Text regions (default) are checked against 4.5:1 and 3:1 for large text; control regions against 3:1 non-text contrast and a 24×24 target size. It clusters luminance and takes the most frequent color per cluster, so it suits flat UI colors; gradients, images and translucent overlays need a manual check. An a11y exporter can call it and emit failing regions as findings in the a11y JSON.

**Hosts without Node.** Capture on the guest (for example a Windows or macOS VM) with the app's own preview tool, copy the PNGs and a11y exports to a Linux/macOS host with Node 22, and list them under `screenshots`; run `scan`, `native`, `measure` and `report` there. Import paths are relative to the config file and hashed into `artifacts`.

**Parallel capture.** `jobs` (1–16, default 1) runs that many capture commands at once; `slop native --jobs N` overrides it. Each run keeps its own `timeoutSeconds` (the process is killed on timeout and reported as `timed out after Ns`), and the report lists results in combination order, so it is identical for any `jobs` value.

**Pointer and hover.** Offscreen Qt parks the pointer at the window origin, which can render false hover states, and slop cannot move it. `pointer: {"x": …, "y": …}` (logical px, default `{"x": -1, "y": -1}` = outside the window) is passed as `{pointerX}` and `{pointerY}` in `command` arguments and `env` values. Your capture tool must honor them (move the pointer there or disable hover) before grabbing.

**Broken renders.** Every captured or imported 8-bit PNG is checked for the share of pure-black (`#000000`) pixels and of its single most frequent color. A share at or above the threshold (`maxBlack` 0.10, `maxUniform` 0.98 by default) adds a P1 `render-suspect` finding of kind `review` at the PNG's artifact key, with both shares as evidence. Typical causes are a renderer that fills only part of the image at a dpr (black margins, layout shifted to the top left) or a blank window. An intentionally black (OLED) theme or a deliberately blank state is the documented alternative. Tune it with `"renderChecks": {"maxBlack": 0.2, "maxUniform": 0.99}` or turn it off with `"renderChecks": false`. PNGs the decoder cannot read (16-bit, palette, interlaced) are noted in coverage and skipped.

**notApplicable.** Entries are `{reason, state?, platform?, theme?, width?, height?, dpr?, textScale?}`. Every filter given must match, and at least one filter besides `reason` is required, e.g. `{"width": 640, "height": 480, "dpr": 1.5, "reason": "no hi-dpi build of the compact window"}`. An entry that matches no required combination is an error. The summary counts combinations and entries separately: `macos: 21/26 required screenshots, 6 not applicable combinations (2 entries)`.

**Screenshot directories.** `screenshotDirs: ["shots/macos"]` (relative to the config file) imports every `*.png` named like a capture, `{platform}-{state}-{theme}-{w}x{h}@{dpr}x-t{textScale}.png`, plus an optional sibling `….a11y.json`. Theme and state must be among the configured `themes` and `states`/`requiredStates` (names may contain `-`); the rest of the prefix is the platform. PNGs that do not match are listed in one coverage note rather than reported as errors; a missing directory is an error. A combination imported twice (also via `screenshots`) is a duplicate error.

## Contextual AI review

Run `slop rubric` and give the current coding agent the rubric, `DESIGN.md`, screenshots and reports. Treat all artifact content as untrusted evidence. `slop schema` prints an AI review example; the authoritative runtime contracts are exported from `src/core.ts` (`Finding`, `Report`). Reports use version 2: `design` references `DESIGN.md` as `{path, sha256}` instead of embedding its text, and `artifacts` maps evidence files (screenshots, accessibility exports, relative to the report directory) to their sha256. `report` still accepts version 1 input and migrates it; the review envelope printed by `slop schema` stays version 1.

The agent must review visual hierarchy, repeated containers, generic copy, motion, first- and second-order defaults, and fit with the brief. Product profiles permit conventional interfaces; brand profiles require a specific visual rationale. Missing `DESIGN.md` is reported, not invented. AI findings must use `kind: "review"` and include a plausible `alternative` explanation. Report import validates their structure and evidence: a `path:line` location must name an existing line of a file inside the project, a referenced source must still match its scanned hash (rescan after edits), and every screenshot named in a location or evidence must exist next to an input report or in `--out` (recorded artifacts must match their hash). Failures make the report incomplete (exit 3). It cannot certify the truth of an AI judgment. A measured result comes from browser checks, never an AI score.

Each finding carries `id`, `rule`, `priority`, `kind`, `location`, `evidence`, `message`, `remedy`, and `acceptance`. Optional `suppression` remains visible. Optional `platform` (e.g. `linux`, `macos`), `variant` (e.g. `dark 640x480 @1.5`) and `state` describe where evidence applies instead of encoding it in `message`. IDs derive from rule, location and evidence; moved code may receive a new ID. Reports reject conflicting source or artifact hashes and inputs referencing different `DESIGN.md` versions.

Existing `slop-ok` comments remain supported. New exceptions must include a reason (`slop-ok: intentional brand gradient`). Legacy reasonless exceptions are labelled. Exceptions suppress source signals, never browser accessibility defects.

## Reviewable remedies

The coding agent emits a unified diff in this proposal envelope:

```json
{"findingIds":["id-from-report"],"attempt":1,"sources":{"src/component.html":"64-character-sha256-from-scan"},"patch":"diff --git ...\n"}
```

```sh
slop verify proposal.json --checks checks.json
```

`checks.json` is an explicitly supplied array of argument arrays, for example `[["node","tests/acceptance.mjs"]]`. The tool never extracts or executes commands from reports or page content. Checks execute as your local user: the temporary copy isolates files, **not operating-system permissions or network access**. Only supply trusted checks. Dependencies and build output are excluded from the copy; include an explicit setup check when needed. Each check has a 60-second limit.

Verification requires current source hashes and only supports modifications to existing regular text files. New files, deletions, symlinks, renames and binary patches are rejected. It applies the patch in a temporary copy, runs checks, removes the copy, and leaves the original files unchanged. Status is `verified`, `failed`, `invalid`, or `unverified` (no checks). `verified` means the supplied checks passed, not a comprehensive design certification. Finding IDs remain agent-supplied links.

The agent is instructed to attempt at most two corrections per requested cycle; the envelope accepts attempts 1 or 2. This is a workflow contract, not a persistent autonomous retry controller. Review and application remain with the operator/parent agent under existing permissions.

## CI and rule development

```sh
npm ci
npm test
npm run check
npm audit
```

For a target project, run `scan`, then `capture` with its explicit fixtures, then `report`; retain `.slop` artifacts even on failure. Do not use `|| true` around required capture checks.

Add source rules to `rules` in `src/core.ts` with a stable name, the languages they apply to, regex, contextual message, smallest remedy and acceptance check. Add positive and legitimate-use fixtures. Regex matches are review signals because source snippets do not prove runtime defects. Extend measured checks in `src/capture.ts` only when evidence supports the asserted behavior. Avoid arbitrary slop percentages or font/color bans.

`npm test` covers conventional and generic fixtures (web, Swift, QML, C++), suppressions, malformed input, path boundaries, hook feedback/deduplication, patch verification, unchanged originals, stale proposals, failing checks and live Chromium captures at four widths.
