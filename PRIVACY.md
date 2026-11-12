# Privacy Policy

**Aspid Translator for GitHub**, a Chrome extension. Last updated: November 12, 2026.

## Summary

The extension processes GitHub page text only on your device. It does not collect that text,
persist it or send it to a server. It has no servers, no analytics and no accounts.

## What the extension reads

On `github.com` pages, the extension reads rendered text in pull requests, issues, comments,
commit messages, PR and issue lists, releases, Discussions, Compare commit messages, Wiki,
READMEs, other rendered Markdown documents, repository About descriptions and signed-in
Home/Feed content cards. That text is handed to Chrome's built-in Translator and
LanguageDetector APIs and to its extension language detector (`chrome.i18n`), which run on your
device. The translated text is shown on the page and is never saved or sent anywhere. Nothing is
posted to GitHub: other people still see the original. Translations remain in the tab's
memory while its content is displayed; the extension does not persist a translation history.

The extension does not run on any other site.

## What the extension stores

Your settings: the target language, whether to translate automatically and which parts of a page
to translate. They are kept in `chrome.storage.local` on your device and never leave it.
You can change these settings on the extension's settings page. Removing the extension
removes its stored settings. Chrome manages downloaded language models separately.

## Network requests

The extension makes no network requests of its own.

The first time you translate a language pair, Chrome downloads a language model from Google.
Chrome makes that request, not the extension, and the text you translate is not part of it.
Google's handling of that download is covered by the
[Google Chrome Privacy Notice](https://www.google.com/chrome/privacy/).

## Data sharing

The extension does not sell, share or transfer any data to third parties, and does not use data
for any purpose other than showing a translation on the page you are reading.

## Permissions

- `storage`: keeps your settings on your device.
- Access to `https://github.com/*`: finds and translates text on GitHub pages.

## Changes

If this policy changes, the new version will be published at this address with a new date.
A future version that adds an online translation engine will say here what is sent and where,
and that engine will stay off until you turn it on.

## Contact

Questions: [open an issue](https://github.com/VPDPersonal/Aspid.GitHub.Translator/issues).
