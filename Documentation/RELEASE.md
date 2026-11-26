# Chrome Web Store release checklist

## Prepare the package

- [ ] Set the release version in `package.json` and `package-lock.json`.
- [ ] Update the [changelog](../CHANGELOG.md) for the release.
- [ ] Run the checks from the commit you intend to ship.

```sh
npm ci
npm run check
```

Confirm the [validation workflow](https://github.com/VPDPersonal/Aspid.Translator.GitHub/actions/workflows/validate.yml) passes on Linux, macOS and Windows. Use its validated Linux artifact for the matching commit, or use the ZIP produced by `npm run check` from that commit. Upload the inner `asp-translator-github-<version>.zip`, which has `manifest.json` at its root.

## Test the release ZIP

Run this check with desktop Google Chrome and an internet connection. It installs the ZIP contents in a clean temporary profile, translates two public pull requests (English to Russian and Chinese to English), toggles between translations and originals, and exercises the downloaded models in an offline tab.

```sh
ASP_SMOKE_COMMIT="$(git rev-parse HEAD)" node scripts/smoke-chrome.mjs
```

Pass a ZIP path as the first argument to test an artifact downloaded from CI. Set `CHROME_PATH` to select another Google Chrome executable. The script writes the ZIP's SHA-256, browser version and results to `release/chrome-smoke.json`. Set `ASP_SMOKE_REPORT` to keep a separate report for each run.

- [ ] Run the real-model check on the final ZIP. Record the SHA-256 with the results.
- [ ] Check model download, retry after interruption and translation on the minimum supported desktop Chrome.
- [ ] Check first-install language selection, the page shortcut, local controls and changes to settings across open tabs.
- [ ] Test signed-in Home/Feed and a private repository with an account that has access.
- [ ] Check model downloads and core translation on the supported desktop platforms.

The regular CI tests use simulated translation responses. Record real-model results with the commit, OS, Chrome version and language pair.

## Submit and publish

- [ ] Review the [listing materials](../store/README.md) and regenerate the screenshots or promo images if the UI has changed. Inspect both language sets.
- [ ] Open the homepage, support and privacy links while signed out of GitHub.
- [ ] Confirm the privacy disclosures match the release and complete the publisher account checks.
- [ ] Upload the tested ZIP and submit it in the [Chrome Web Store Developer Dashboard](https://developer.chrome.com/docs/webstore/publish).
- [ ] After approval, install the published extension in a clean profile and check its version and core translation.
- [ ] Add the direct store link to the README. Publish the matching Git tag and GitHub Release with the tested ZIP and release notes.
