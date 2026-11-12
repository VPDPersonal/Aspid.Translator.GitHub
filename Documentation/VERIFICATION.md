# Release candidate verification

Recorded on November 12, 2026. These results cover preparation branches before merge;
repeat the release gates on the final commit and the uploaded Web Store package.

## Candidate and automated checks

The combined working-tree candidate contains runtime PR #15 (`c836744`) and release
validation PR #16 (`6c17f75`). The merge applied without conflicts. The later
`05ac755` change adjusts only hosted Chrome selection and test logging; it does not
change extension runtime code.

- `CI=true npm run check` on macOS: 65 tests passed.
- Release preflight: version 0.1.0, 79 packaged files and 39 locales validated.
- `npm audit --audit-level=high`: zero vulnerabilities with Puppeteer 25.17.0.
- Workflow lint and local README path checks passed.
- All four jobs passed on PR #16 head `05ac755`: Linux with Chrome 138 and stable Chrome,
  Windows with stable Chrome, and macOS 15 Intel with the runner-installed Google Chrome.
  Each job ran 54 tests, reported zero dependency vulnerabilities and validated the archive.
  The 65-test result above covers the separate runtime PR combined with these checks.
- The hosted macOS job used Google Chrome 151.0.7922.174. Linux's minimum-version job used
  Chrome for Testing 138.0.7204.183; its stable job used 157.0.8103.78. Real-model checks
  below separately used Google Chrome 157 on macOS.
- CI evidence: [successful run](https://github.com/VPDPersonal/Aspid.GitHub.Translator/actions/runs/43217497475).
  Downloaded Chrome for Testing stalled during hosted macOS CDP startup; the green macOS
  job uses the runner's installed browser and fails shared setup promptly if CDP is unavailable.

## Installed extension and actual models

On macOS with Google Chrome 157.0.8103.51, the installed runtime candidate was exercised
against public PRs with a clean temporary profile. No Translator, LanguageDetector or
extension-detector stand-ins were installed.

- English to Russian: visible content translated with no translation-control errors.
- Chinese to English: visible content translated with no translation-control errors.
- The page-wide control restored originals and then restored translations.
- After model download, both language pairs also translated sample text offline through
  Chrome's native Translator API.
- Each language pair started successfully with one download-control click. The smoke
  report records the click count and prepared source/target pairs. Model preparation now
  shows busy feedback immediately, before Chrome sends a progress event.
- Browser page errors: none in the recorded successful runs.

`node scripts/smoke-chrome.mjs` writes a machine-readable report to
`release/chrome-smoke.json`. Set `ASP_SMOKE_COMMIT` to the build commit or candidate refs,
`CHROME_PATH` for another browser binary, and `ASP_SMOKE_REPORT` to retain a separate report.
The script deletes only its own temporary browser profile after the check.

## Store materials

All ten English and Russian screenshots were regenerated from installed runtime
`0892b7c` using its normal detection path, then visually inspected. The subsequent
`c836744` change affects preparation feedback; the settled controls shown in these
images are unchanged. Their dimensions are 1280×800.
Both promo tiles were rendered and inspected at 440×280 and 1400×560.

Two capture attempts needed a fresh-page retry: GitHub's browser-stats request failed on
one page, and Chrome reported a transient generic translation failure on another. Final
captures completed without translation-error controls. This is evidence of recovery, not
proof that Chrome or GitHub never fails.

## Remaining verification and owner actions

A signed-out request to the configured privacy-policy URL returned HTTP 404 because the
repository is private. Public privacy, homepage and support URLs remain a release gate.

Actual model downloads on Chrome 138, interrupted-download recovery, authenticated
Home/Feed, private repository interaction, real model translation on Windows and Linux,
external tester feedback and installation from Chrome Web Store have not been verified.
The minimum-version test above uses DOM fixtures and simulated translation responses.

The Dashboard, publisher account, submission, review, repository visibility and tester
outreach were not changed. Follow [RELEASE.md](RELEASE.md) for the final checklist.
