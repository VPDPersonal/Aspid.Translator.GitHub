// Exercises the packaged extension and Chrome's real model APIs on public GitHub pages.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import puppeteer from 'puppeteer-core';
import { sourceLocales, validateRelease } from './validate-release.mjs';

const root = resolve(import.meta.dirname, '..');
const { name, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const archive = process.argv[2] ?? join(root, 'release', `${name}-${version}.zip`);
const output = resolve(root, process.env.ASP_SMOKE_REPORT ?? 'release/chrome-smoke.json');
const scenarios = [
  { url: 'https://github.com/vuejs/core/pull/15853', source: 'en', target: 'ru', sample: 'Hello world' },
  { url: 'https://github.com/NervJS/taro/pull/19523', source: 'zh', target: 'en', sample: '你好，世界' },
];
const fab = '.ght-fab';
const visibleTranslation = '[data-ght-clone]:not([data-ght-hidden])';
const report = {
  startedAt: new Date().toISOString(),
  platform: process.platform,
  buildCommit: process.env.ASP_SMOKE_COMMIT ?? null,
  archive,
  cases: [],
  passed: false,
};

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'asp-translator-smoke-'));
let browser;

try {
  const bytes = await readFile(archive);
  const files = unzipSync(bytes);
  report.version = validateRelease(files, { version, locales: await sourceLocales() }).version;
  report.archiveSha256 = createHash('sha256').update(bytes).digest('hex');

  const extensionDirectory = join(temporaryDirectory, 'extension');
  for (const [path, contents] of Object.entries(files)) {
    const file = join(extensionDirectory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }

  browser = await puppeteer.launch({
    channel: 'chrome',
    executablePath: process.env.CHROME_PATH,
    headless: true,
    pipe: true,
    enableExtensions: true,
    protocolTimeout: 30000,
    userDataDir: join(temporaryDirectory, 'profile'),
    ignoreDefaultArgs: (await puppeteer.defaultArgs()).filter(arg => arg.startsWith('--disable-features=')
      || ['--disable-background-networking', '--disable-component-extensions-with-background-pages'].includes(arg)),
    args: ['--enable-unsafe-extension-debugging', ...(process.env.CI ? ['--no-sandbox'] : [])],
  });
  report.browser = await browser.version();
  console.log(`Testing ${report.browser} with a clean profile`);

  const extensionId = await browser.installExtension(extensionDirectory);
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  const labels = await settings.evaluate(() => ({
    download: chrome.i18n.getMessage('fabDownloadModel'),
    showOriginals: chrome.i18n.getMessage('fabShowOriginals'),
    translateAll: chrome.i18n.getMessage('fabTranslateAll'),
  }));

  for (const { url, source, target, sample } of scenarios) {
    const result = { url, source, target, modelClicks: 0, pageErrors: [], passed: false };
    report.cases.push(result);
    await settings.evaluate(target => chrome.storage.local.set({ settings: { target, auto: true } }), target);
    const page = await browser.newPage();
    page.on('pageerror', error => result.pageErrors.push(error.message));
    await page.setViewport({ width: 1280, height: 900 });
    console.log(`Opening ${url} for ${source} → ${target}`);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    assert.equal(response?.status(), 200, 'Public GitHub page must load successfully');
    await page.waitForSelector(fab, { timeout: 15000 });

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      result.state = await page.evaluate(({ fab, visibleTranslation, target }) => ({
        button: document.querySelector(fab)?.textContent,
        translated: document.querySelectorAll(`${visibleTranslation}[lang="${target}"]`).length,
        errors: Array.from(document.querySelectorAll('.ght-toggle[data-state="error"]'), el => el.title),
      }), { fab, visibleTranslation, target });

      if (result.state.button === labels.download) {
        await page.click(fab);
        result.modelClicks++;
        console.log('Clicked the model download control');
      } else if (result.state.button === labels.showOriginals && result.state.translated > 0) {
        break;
      }
      await delay(1000);
    }
    assert.equal(result.state?.button, labels.showOriginals, 'Translation must settle within three minutes');
    assert.ok(result.state.translated > 0, 'The package must display a translation in the target language');
    assert.deepEqual(result.state.errors, [], 'Translation controls must have no errors');

    await page.click(fab);
    assert.equal(await page.$eval(fab, button => button.textContent), labels.translateAll);
    assert.equal(await page.$(visibleTranslation), null, 'The page control must restore originals');
    await page.click(fab);
    await page.waitForSelector(visibleTranslation, { timeout: 10000 });

    await page.setOfflineMode(true);
    result.offline = await page.evaluate(async ({ source, target, sample }) => {
      const signal = AbortSignal.timeout(15000);
      const model = await Translator.create({ sourceLanguage: source, targetLanguage: target, signal });
      try {
        const text = await model.translate(sample, { signal });
        return Boolean(text.trim()) && text !== sample;
      } finally {
        model.destroy();
      }
    }, { source, target, sample });
    assert.equal(result.offline, true, 'A downloaded model must translate while the page is offline');
    result.passed = true;
    await page.close();
    console.log(`Passed ${source} → ${target} (${result.state.translated} translated elements)`);
  }
  report.passed = true;
} catch (error) {
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report: ${output}`);
  }
}
