# Changelog

## Unreleased

- Docs: research wave 4 on GitHub anti-slop UI repos. `03` B5 now groups rule/skill sets, DESIGN.md briefs (VoltAgent, Google design.md spec and lint CLI), LLM-free detectors and generators (ui-ux-pro-max, 21st MCP, superdesign) with verified stars and licenses; new B6 (shared techniques, catalog vs. ban disagreement, Space Grotesk conflict) and B7 (star-count caution). `02`, `05` and `00` updated; the "67 tells" count for avoid-ai-design is marked unconfirmed.

## 0.3.0 — 2026-11-06

- `report` accepts artifact keys outside `--out` (`../shots/x.png`) and bare screenshot names that match exactly one artifact; absolute keys are rejected.
- QML `gradient` no longer flags passed-through properties (`gradient: root.fillGradient`).
- `slop.json` `scopedOverrides` change priorities per path glob and rule.
- `slop measure` regions take a `text` or `control` kind; target size is only checked for controls.
- `slop scan` without paths and without `src` explains how to pass paths.
- `slop native`: `render-suspect` review findings for captures with large pure-black or single-color areas (`renderChecks`), `{pointerX}`/`{pointerY}` placeholders, parallel capture via `jobs`/`--jobs`, `notApplicable` filters for size/dpr/textScale, `screenshotDirs` import by file name, and coverage that counts not-applicable combinations and entries separately without repeating "no a11y data" per shot.

## 0.2.0 — 2026-11-06

- Add `slop measure` for per-region contrast and target-size checks on PNG screenshots.
- `slop --version` / `-V`; schema errors print one line per problem with the file name instead of raw zod JSON.
- Findings require a non-empty `id`, `rule` and `location`; copy findings in labels under four words are P2.
- Document the capture-on-guest, evaluate-on-host flow for hosts without Node.

- Add `06-design-systeme.md`: cited rules from Material 3, Apple HIG, Fluent 2, Carbon and Cloudscape (verified) plus GOV.UK, USWDS, Baymard, NN/g, GNOME and KDE HIG (unverified) on target sizes, contrast, grids, state layers, motion, density, empty states, forms and native apps; upgrade matching evidence markers in `01` and record research wave 3 in `05`.
- Scan Swift, QML and C++ (Qt) sources in `scan` and the edit hook with language-specific rules; web-only rules no longer apply to native files.
- Skip native build output (`.build`, `DerivedData`, Qt/CMake shadow builds) and generated `moc_`/`qrc_` sources; native raw-color signals are skipped in theme/palette files.
- Report format version 2: reference `DESIGN.md` by path and sha256 instead of embedding it; add `artifacts` hashes and optional `platform`/`variant`/`state` on findings. Version 1 reports are still accepted as input.
- `report` validates that `path:line` locations exist and match scanned hashes and that referenced screenshots exist.
- `slop --help` and `-h` print usage instead of failing.
- Fewer native false positives: literal-only `raw-token`, marketing-only "Unlock", primary-font-only `type-default`, clearer `focus`/`gradient` guidance; skip test/fixture, vendored, minified and Qt Linguist `.ts` sources and lines over 1000 characters, with a visible `Skipped:` coverage line.
- Optional strict `slop.json` project config: `exclude`, `tokenFiles`, `includeTests`, `severityOverrides`.
- Add `slop native` for Swift/QML/Qt evidence: state × theme × size × dpr × text-scale matrix via an operator-supplied capture command (argv and env placeholders) or imported screenshots, explicit missing/not-applicable coverage, a11y export import as measured findings with severity overrides, and PNG-based contrast estimates.

## 0.1.0 — 2026-11-05

- Add TypeScript CLI for source review, browser evidence, report merging and corrective agent feedback.
- Add Claude edit hook adapter with bounded output and per-file deduplication.
- Add context-aware review rubric and hash-checked patch verification in temporary copies.
- Add real-browser and end-to-end fixtures; retain the dependency-free shell templates.
