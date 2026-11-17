# Vendored slop-detector

`slop-detector/` is based on a `git archive` of
`ssh://git@git.alpha-labs.net:2222/christian/slop-detector.git` at commit
`ee264c609e3627145ff00f47d6475fab0c7c0d4e` (release 0.3.1 plus the brand review rubric and the arbitrated guidelines), limited to
`src/`, the package files, the guidelines `00-06-*.md`, `README.md` and `CHANGELOG.md`.
Tests, fixtures and templates are left out.

It is vendored because the server-side image build has no access to that private
repository. The slop worker runs only `scan`, `report` and `rubric`; `capture`,
`native` and `verify` execute pages or commands and are never invoked server-side.

Update: `git -C ../slop-detector archive <commit> src package.json package-lock.json
tsconfig.json 0*.md README.md CHANGELOG.md | tar -x -C slop-worker/vendor/slop-detector`
(remove the old directory first), update the commit above and the CHANGELOG.

Local patches (2026-11-08, re-applied on 2026-11-12): web typography checks require a font declaration and a whole font name; source coverage reports unsupported-extension skips. Regression tests live in `api/test/unit/services/slop-scanner.test.ts`.

Local patches (2026-11-17): web context checks distinguish native `dialog::backdrop` declarations from glass containers and recognize static replacement focus width on the same element's class attribute. Mixed selectors, neighbouring controls, conditional classes and zero/transparent widths remain reviewable. Tests: `api/test/unit/services/slop-scanner.test.ts`. The worker also preserves API snapshot artifact hashes in the scan report used by final evidence validation (`slop-worker-evidence.test.ts`); upstream's existing unique-basename resolution is unchanged.
