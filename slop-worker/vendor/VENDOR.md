# Vendored slop-detector

`slop-detector/` is based on a `git archive` of
`ssh://git@git.alpha-labs.net:2222/christian/slop-detector.git` at commit
`31f4e28be87f21072f14d7e536456eb12b5d62e8` (release 0.3.0 plus research docs), limited to
`src/`, the package files, the guidelines `00-06-*.md`, `README.md` and `CHANGELOG.md`.
Tests, fixtures and templates are left out.

It is vendored because the server-side image build has no access to that private
repository. The slop worker runs only `scan`, `report` and `rubric`; `capture`,
`native` and `verify` execute pages or commands and are never invoked server-side.

Update: `git -C ../slop-detector archive <commit> src package.json package-lock.json
tsconfig.json 0*.md README.md CHANGELOG.md | tar -x -C slop-worker/vendor/slop-detector`
(remove the old directory first), update the commit above and the CHANGELOG.

Local patches (2026-11-08): web typography checks require a font declaration and a whole font name; source coverage reports unsupported-extension skips. Regression tests live in `api/test/unit/services/slop-scanner.test.ts`.
