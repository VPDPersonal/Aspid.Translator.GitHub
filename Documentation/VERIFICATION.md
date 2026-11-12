# Release candidate verification

Recorded on November 12, 2026. These results cover preparation branches before merge;
repeat the release gates on the final commit and the uploaded Web Store package.

## Candidate and automated checks

The combined working-tree candidate contains runtime PR #15 (`0892b7c`) and release
validation PR #16 (`74407e8`). The merge applied without conflicts. The later
`35565bb` change pins only the hosted macOS runner; it does not change runtime code.

- `CI=true npm run check` on macOS: 64 tests passed.
- Release preflight: version 0.1.0, 79 packaged files and 39 locales validated.
- `npm audit --audit-level=high`: zero vulnerabilities with Puppeteer 25.17.0.
- Workflow lint and local README path checks passed.
- Chrome 138 DOM integration and package validation passed on Linux in PR #16.
- Stable Chrome jobs passed on Linux and Windows in PR #16.
- Hosted macOS browser startup needs a green CI run before release; local macOS passes
  do not substitute for that run. See the current checks on PR #16.

## Installed extension and actual models

On macOS with Google Chrome 157.0.8103.51, the installed runtime candidate was exercised
against public PRs with a clean temporary profile. No Translator, LanguageDetector or
extension-detector stand-ins were installed.

- English to Russian: visible content translated with no translation-control errors.
- Chinese to English: visible content translated with no translation-control errors.
- The page-wide control restored originals and then restored translations.
- After model download, both language pairs also translated sample text offline through
  Chrome's native Translator API.
- Initial model setup required repeated download-control clicks; the smoke runner records
  those actions in its console output. The test does not establish a one-click cold start.
- Browser page errors: none in the recorded successful runs.

`node scripts/smoke-chrome.mjs` writes a machine-readable report to
`release/chrome-smoke.json`. Set `ASP_SMOKE_COMMIT` to the build commit or candidate refs,
`CHROME_PATH` for another browser binary, and `ASP_SMOKE_REPORT` to retain a separate report.
The script deletes only its own temporary browser profile after the check.

## Store materials

All ten English and Russian screenshots were regenerated from the installed candidate
using its normal detection path, then visually inspected. Their dimensions are 1280×800.
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
