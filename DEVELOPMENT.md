# Extension development

Use Node.js 22.17 or newer and an installed desktop Chrome.

```bash
npm ci
npm run build
```

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select
`dist/`. Click the extension icon to open its settings.

## Local workflow

Run `npm run watch` for JavaScript changes. Restart it after editing static HTML, CSS,
locale files or icons to refresh the copied assets. Reload the extension in `chrome://extensions`
and refresh any open GitHub tab to load the new content scripts.

Run `npm test` for the translation, DOM and packaging tests. The end-to-end test installs the
contents of the release ZIP in a temporary Chrome profile and changes settings in an open tab.
These tests use a translation stand-in. Set `CHROME_PATH` to override the system Chrome executable.
Check Chrome's real translation models and personalized Home/Feed layouts manually.

Run `npm run check` to run the tests, build the Web Store archive and validate
its manifest, permissions, localized messages, icons, fonts and licenses.
To validate an existing archive after `npm run zip`, run `npm run validate`.
GitHub Actions runs these checks on Linux, macOS and Windows and keeps the
validated Linux ZIP as an artifact. Model downloads still need a separate manual check.
The Linux matrix also checks Chrome 138, and the workflow rejects high-severity tooling
dependency advisories with `npm audit`.

| Path | Role |
|---|---|
| `src/content.js` | Finds what to translate on GitHub pages, runs the translation queue, renders labels and toggles. |
| `src/pages.js` | Classifies routes and selects content on issues, lists, releases, Discussions, Compare, Wiki and activity feeds. |
| `src/controls.js` | Groups local translations and places controls beside titles, native actions and comment reactions. |
| `src/dom.js` | Splits rendered markdown into segments with placeholder tags and writes translations back. |
| `src/providers/` | Translation engines. `index.js` defines the `Provider` interface and the list of engines. |
| `src/page-bridge.js` | Content-side client for `bridge.js`; detects the language of a text, falling back to `chrome.i18n.detectLanguage` when the `LanguageDetector` model is missing (as in Dia). |
| `src/bridge.js` | Runs in the page's main world and calls the built-in `Translator` and `LanguageDetector` APIs. |
| `src/background.js` | Service worker: opens the settings. |
| `src/settings.js` | Stored settings, their defaults and the list of target languages. |
| `src/options.js`, `static/options.html` | Settings page. |
| `src/i18n.js`, `static/_locales/` | UI strings in every target language. |
| `src/locales.js` | Bundles every locale into the settings page, which shows the target language's strings. |
| `static/` | Manifest, styles and locales, copied to `dist/` as is. |
| `assets/` | The shared translator logo (`banner-logo.svg`), generated with `npm run icons` from the faceted Aspid snake (`aspid-snake.png`). The build renders it to PNG for Chrome. |
| `build.mjs` | Bundles the scripts, renders the icons, copies the IBM Plex fonts of the settings page from `@fontsource`, sets the manifest version from `package.json` and packs the archive. |
| `store/` | Chrome Web Store listing: descriptions, Dashboard answers, screenshots, promo tiles and `render.mjs`, which renders the images. |

To release a new version, bump `version` in `package.json` and run `npm run zip`.
When the UI changes, re-render the store images with `npm run store:shots` and `npm run store:promo`:
they run system Chrome headless (or the executable in `CHROME_PATH`).
The Dashboard fields are in [`store/README.md`](store/README.md).

To add a UI language, copy `static/_locales/en/messages.json` to a folder named after the
[locale code](https://developer.chrome.com/docs/extensions/reference/api/i18n#locales) and translate
the `message` fields. Keep the `$NAME$` placeholders as they are. The settings page bundles every
locale and shows it when its language is the target.

To add a translation engine, implement the `Provider` interface from `src/providers/index.js`
in a new module next to it and add it to `PROVIDERS`. The settings page and the content script
pick it up from there. Engines that call a network API send their requests from the background
service worker and need the API host in `host_permissions`.
