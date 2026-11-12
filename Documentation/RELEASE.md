# Public release checklist

Use the final commit and archive for every check below. A passing DOM test suite does not
verify Chrome model downloads, live GitHub layouts or installation from the Web Store.

## Repository and public resources

- [ ] Merge the release preparation PRs and verify their checks on the combined commit.
- [ ] Choose the release version in `package.json` before producing the final ZIP.
- [ ] Make the privacy policy available without signing in.
- [ ] Provide a public homepage and support channel.
- [ ] Open each listing URL in a signed-out browser and confirm it loads.

The repository was private during the November 12, 2026 audit. Its configured privacy URL
returned HTTP 404 without authentication. The URLs in `store/README.md` are usable only after
public access is confirmed. The owner can publish this repository after reviewing its
contents and history, or host `PRIVACY.md` separately and supply another public support
channel. Update every listing URL and support link if choosing separate hosting.

## Automated verification

Use Node.js 22.17 or newer and desktop Chrome. Set `CHROME_PATH` if Chrome is not at the
macOS default path.

```bash
npm ci
npm test
npm run zip
```

After the release validation CI PR is merged, `npm run check` also builds and validates the
archive. Require green Linux, macOS and Windows jobs for the final commit. The resulting
`release/aspid-github-translator-<version>.zip` must contain `manifest.json` at its root.
Use the matching workflow artifact or rebuild the exact commit; do not upload an older ZIP.

## Real Chrome verification

- [ ] Install the packaged extension in a clean Chrome profile.
- [ ] Confirm the target follows preferred browser languages on first installation.
- [ ] Translate English to Russian and Chinese or Japanese to English.
- [ ] Confirm a first-run click starts model downloads and progress completes.
- [ ] Interrupt a model download, restore the connection and retry.
- [ ] Verify an already downloaded language pair works offline on loaded content.
- [ ] Check unsupported language pairs produce a recoverable message.
- [ ] Verify automatic and manual translation, local toggles and the page-wide toggle.
- [ ] Change settings with GitHub tabs open and confirm the tabs update.
- [ ] Check original text, code, links, mentions, anchors and editors stay usable.
- [ ] Exercise PR, Issue, list, commit, README, release, Discussion, Compare and Wiki pages.
- [ ] Check signed-in Home/Feed and a private repository without sharing its content.
- [ ] Check the minimum supported Chrome separately from the current stable release.
- [ ] Repeat installation and core translation on Windows and macOS.

`node scripts/smoke-chrome.mjs` runs a bounded smoke check with the installed extension and
real browser APIs against two public PRs. It uses a temporary profile and saves its report in
`release/chrome-smoke.json`. It does not replace interrupted-download, signed-in, minimum
version, cross-platform or Web Store installation checks. No translation or detector
stand-ins are installed by this command.

Record results with the commit SHA, OS, Chrome version, language pair, clean or reused
profile, outcome and any errors. Keep unrun scenarios marked as unrun.

## Listing and review

- [ ] Refresh screenshots with `npm run store:shots` and inspect both language sets.
- [ ] Refresh promo tiles with `npm run store:promo` and inspect their text and dimensions.
- [ ] Paste the current English and Russian descriptions from `store/`.
- [ ] Confirm privacy disclosures match the shipped code and cover all supported page types.
- [ ] Confirm public privacy, homepage and support URLs in the Dashboard.
- [ ] Verify the developer account, contact details and required account security.
- [ ] Upload the final ZIP, complete the listing and submit it for review.
- [ ] Use deferred publishing if the release should wait for a coordinated announcement.

Publishing reference: <https://developer.chrome.com/docs/webstore/publish>.
Local-only data handling still needs a privacy policy:
<https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>.

## External beta and launch

- [ ] Ask a small external group to test the reviewed package on their own computers.
- [ ] Fix release-blocking findings and repeat the affected checks on the new archive.
- [ ] After approval, publish and verify installation from the actual Web Store listing.
- [ ] Replace `coming soon` in the README with the verified installation URL.
- [ ] Create the matching Git tag and GitHub Release with release notes and the final ZIP.
- [ ] Verify the uploaded asset and store version match the checked package.
- [ ] Announce the verified installation link and monitor public support reports.

The owner completes Dashboard submission, public visibility decisions and tester outreach.
Do not record these as completed based on source changes or local automation.
