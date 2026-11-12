// Exercises the installed extension and Chrome's actual model APIs on public GitHub pages.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const profile = await mkdtemp(join(tmpdir(), 'asp-github-smoke-'));
const report = {
  startedAt: new Date().toISOString(), platform: process.platform, profile: 'clean temporary profile',
  buildCommit: process.env.ASP_SMOKE_COMMIT ?? 'not supplied; record the build commit before release',
  manifest: JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8')).version, cases: [],
};
const scenarios = [
  { url: 'https://github.com/vuejs/core/pull/15853', target: 'ru', source: 'en' },
  { url: 'https://github.com/NervJS/taro/pull/19523', target: 'en', source: 'zh' },
];
let browser;
const stateOf = page => page.evaluate(() => ({
  button: document.querySelector('.ght-fab')?.textContent ?? '',
  translated: document.querySelectorAll('[data-ght-clone]').length,
  loading: document.querySelectorAll('.ght-toggle[data-state="loading"]').length,
  errors: [...document.querySelectorAll('.ght-toggle[data-state="error"]')].map(el => el.title),
}));

try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, enableExtensions: true, userDataDir: profile,
    ignoreDefaultArgs: (await puppeteer.defaultArgs()).filter(arg => arg.startsWith('--disable-features=')
      || ['--disable-background-networking', '--disable-component-extensions-with-background-pages'].includes(arg)),
    args: ['--lang=en-US', '-AppleLanguages', '(en-US)', ...(process.env.CI ? ['--no-sandbox'] : [])],
  });
  report.browser = await browser.version();
  console.log(`Testing ${report.browser} with a clean profile`);
  const extensionId = await browser.installExtension(join(root, 'dist'));
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  for (const scenario of scenarios) {
    const result = { ...scenario, passed: false, modelClicks: 0, pageErrors: [] };
    report.cases.push(result);
    await settings.evaluate(target => chrome.storage.local.set({ settings: { target, auto: true } }), scenario.target);
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__aspSmokePreparations = [];
      window.addEventListener('ght:req', event => {
        try {
          const { op, args } = JSON.parse(event.detail);
          if (op === 'translator.prepare') window.__aspSmokePreparations.push({ source: args.source, target: args.target });
        } catch { /* Ignore unrelated malformed events. */ }
      });
    });
    page.on('pageerror', error => result.pageErrors.push(error.message));
    await page.setViewport({ width: 1280, height: 900 });
    console.log(`Opening ${scenario.url}, target ${scenario.target}`);
    const response = await page.goto(scenario.url, { waitUntil: 'networkidle2', timeout: 60000 });
    assert.equal(response.status(), 200, 'Public GitHub page must load successfully');
    result.apis = await page.evaluate(async ({ source, target }) => {
      const bounded = promise => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve('availability timed out'), 5000))]);
      return {
        translator: typeof Translator,
        detector: typeof LanguageDetector,
        translationAvailability: typeof Translator === 'undefined' ? 'missing' : await bounded(Translator.availability({ sourceLanguage: source, targetLanguage: target })),
        detectionAvailability: typeof LanguageDetector === 'undefined' ? 'missing' : await bounded(LanguageDetector.availability()),
      };
    }, scenario);
    console.log(JSON.stringify(result.apis));
    await page.waitForSelector('.ght-fab', { timeout: 15000 });
    let quiet = 0;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      result.state = await stateOf(page);
      if (/model|модел/i.test(result.state.button) && !/%/.test(result.state.button)) {
        await page.click('.ght-fab');
        result.modelClicks++;
        console.log('Clicked the model download control');
      }
      if (result.state.translated && !result.state.loading && !/…|%/.test(result.state.button)) {
        if (++quiet >= 2) break;
      } else quiet = 0;
      await delay(1000);
    }
    console.log(JSON.stringify(result.state));
    result.preparedPairs = await page.evaluate(() => window.__aspSmokePreparations);
    assert.ok(quiet >= 2, 'Translation did not settle within three minutes');
    assert.equal(result.state.errors.length, 0, 'Translation controls must not show errors');
    assert.ok(result.state.translated > 0, 'At least one element must have a real translation');
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', nodes => nodes.filter(node => !node.hasAttribute('data-ght-hidden')).length), 0, 'The page control must restore originals');
    await page.click('.ght-fab');
    assert.ok(await page.$$eval('[data-ght-clone]', nodes => nodes.some(node => !node.hasAttribute('data-ght-hidden'))), 'The page control must restore translations');
    await page.setOfflineMode(true);
    result.offline = await page.evaluate(async ({ source, target }) => {
      const model = await Translator.create({ sourceLanguage: source, targetLanguage: target });
      try {
        const sample = source === 'en' ? 'Hello world' : '你好，世界';
        const translated = await model.translate(sample);
        return { passed: Boolean(translated.trim()) && translated !== sample };
      } finally {
        model.destroy();
      }
    }, scenario);
    assert.equal(result.offline.passed, true, 'A downloaded model must translate while offline');
    await page.setOfflineMode(false);
    result.passed = true;
    await page.close();
  }
  report.passed = report.cases.every(result => result.passed);
} catch (error) {
  report.passed = false;
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await rm(profile, { recursive: true, force: true });
  await mkdir(join(root, 'release'), { recursive: true });
  const output = process.env.ASP_SMOKE_REPORT ?? 'release/chrome-smoke.json';
  await writeFile(resolve(root, output), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${output}`);
}
