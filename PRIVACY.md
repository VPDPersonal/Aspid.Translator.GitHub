# Aspid.Translator.GitHub Privacy Policy

Last updated: November 24, 2026

Aspid.Translator.GitHub is a browser extension that translates text in place on
`github.com`. It processes page text on your device. It does not upload that
text or its translations to the developer, GitHub, Google, or an online
translation service.

## What the extension accesses and why

- **GitHub page text.** The extension reads text in supported sections of the
  GitHub pages you open, according to your translation settings. This includes
  pull requests, issues, comments and reviews, commits, repository descriptions
  and rendered Markdown, releases, discussions, wikis, lists, and activity
  cards. It can process text from private repositories you can already access.
  The text may include personal information if it appears in those sections.
  The extension uses the text to detect its language, translate it, and display
  the translation on that page. It does not post translations or edits to GitHub.
- **Language preferences.** The extension reads the browser's preferred and
  interface languages to choose a default target language. You can override
  that choice in the extension settings.
- **Active tab.** When you use the translation shortcut, the extension uses
  the active tab's ID to route the command. It does not store a browsing history.

## Where processing happens and what leaves the device

The extension uses Chrome's on-device Translator and Language Detector APIs
and may fall back to Chrome's built-in extension language detector
(`chrome.i18n.detectLanguage`). The extension passes text and results between
its scripts in the browser on the current GitHub page to use these APIs.
This is local processing, not a network request. Because the translation is
displayed in the page, scripts running on that page can access the displayed
text.

Chrome may contact Google to download the translation or language-detection
models it needs. Chrome handles these downloads; the GitHub text submitted
for translation and the resulting translations are not part of the download
requests. See the [Google Chrome Privacy Notice](https://www.google.com/chrome/privacy/)
for how Google handles Chrome requests.

The extension has no backend, analytics, advertising, or extension account.
It does not send page text, translations, or your extension preferences to the
developer or any other remote recipient. It does not sell this data, use it for
advertising or profiling, or provide the developer with access to your page text.

## Storage, retention, and controls

The extension keeps original and translated text in the browser while the page
is open. It does not write that text to persistent extension storage. It uses
`chrome.storage.local` to retain translation preferences, including the target
language, automatic translation, which parts of the page to translate, and the
selected translation engine (currently only Chrome's built-in engine). The
extension does not sync these settings. Removing the extension clears its
locally stored preferences; Chrome manages its downloaded models separately.

In the extension settings, you can turn off automatic translation, disable
individual content types, or change the target language. You can disable or
remove the extension in Chrome to stop it from processing pages.

## Permissions

- **`storage`** saves translation preferences on your device.
- **Site access to `https://github.com/*`** lets the extension read supported
  page text and display the translation in place. It does not inject
  translation scripts on other sites.

## Chrome Web Store Limited Use

Aspid.Translator.GitHub's use of user data complies with the
[Chrome Web Store User Data Policy, including its Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

## Changes and contact

When this policy changes, the revised version will show a new date. For
privacy questions, use the support contact on the Chrome Web Store listing
once available, or [open an issue](https://github.com/VPDPersonal/Aspid.Translator.GitHub/issues)
if you have repository access. Do not include text from private repositories
or other sensitive information in a support request.
