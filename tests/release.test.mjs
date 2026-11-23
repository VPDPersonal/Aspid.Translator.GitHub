import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { promisify } from 'node:util';
import { before, test } from 'node:test';
import { unzipSync } from 'fflate';
import { sourceLocales, validateRelease } from '../scripts/validate-release.mjs';

let files, options;
before(async () => {
  const root = new URL('../', import.meta.url);
  await promisify(execFile)(process.execPath, ['build.mjs', '--zip'], { cwd: root });
  const { name, version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  files = unzipSync(await readFile(new URL(`release/${name}-${version}.zip`, root)));
  options = { version, locales: await sourceLocales() };
});
const encoded = value => new TextEncoder().encode(JSON.stringify(value));

test('the production build produces a complete, localized Web Store archive', () => {
  const result = validateRelease(files, options);
  assert.equal(result.version, options.version);
  assert.equal(result.locales, options.locales.length);
});

test('preflight rejects missing scripts, fonts, license and locales', () => {
  for (const path of ['bridge.js', 'fonts/ibm-plex-sans-latin-400-normal.woff2', 'LICENSE', '_locales/ru/messages.json']) {
    const broken = { ...files };
    delete broken[path];
    assert.throws(() => validateRelease(broken, options), /Missing|locales differ/);
  }
});

test('preflight rejects version drift, expanded access and wrong-sized icons', () => {
  assert.throws(() => validateRelease(files, { ...options, version: '0.2.0' }), /version must match/);
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  manifest.content_scripts[0].matches = ['https://*/*'];
  assert.throws(() => validateRelease({ ...files, 'manifest.json': encoded(manifest) }, options), /only run on github.com/);
  manifest.content_scripts[0].matches = ['https://github.com/*'];
  manifest.permissions.push('tabs');
  assert.throws(() => validateRelease({ ...files, 'manifest.json': encoded(manifest) }, options), /privacy disclosures/);
  assert.throws(() => validateRelease({ ...files, 'icons/icon-128.png': files['icons/icon-16.png'] }, options), /Wrong icon width/);
});

test('preflight rejects locale omissions, broken substitutions and oversized summaries', () => {
  const locale = JSON.parse(new TextDecoder().decode(files['_locales/ru/messages.json']));
  delete locale.actionRetry;
  assert.throws(() => validateRelease({ ...files, '_locales/ru/messages.json': encoded(locale) }, options), /locale keys/);
  locale.actionRetry = { message: 'Retry' };
  locale.labelError.message = 'Broken $OTHER$';
  assert.throws(() => validateRelease({ ...files, '_locales/ru/messages.json': encoded(locale) }, options), /message placeholders/);
  locale.labelError.message = 'Broken $ERROR$';
  locale.extDescription.message = 'x'.repeat(133);
  assert.throws(() => validateRelease({ ...files, '_locales/ru/messages.json': encoded(locale) }, options), /132 characters/);
});

test('preflight rejects unexpected source, credentials and traversal entries', () => {
  for (const path of ['.env', '../manifest.json', 'node_modules/package.json', 'content.js.map']) {
    assert.throws(() => validateRelease({ ...files, [path]: new Uint8Array([1]) }, options), /Unexpected packaged file/);
  }
});

test('preflight requires both scripts in their correct execution worlds', () => {
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  delete manifest.content_scripts[0].world;
  assert.throws(() => validateRelease({ ...files, 'manifest.json': encoded(manifest) }, options), /MAIN world/);
  manifest.content_scripts = [];
  assert.throws(() => validateRelease({ ...files, 'manifest.json': encoded(manifest) }, options), /both translation content scripts/);
});

test('the packaged extension translates a GitHub page and applies saved options across tabs', async t => {
  validateRelease(files, options);
  const directory = await mkdtemp(join(tmpdir(), 'asp-translator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [path, bytes] of Object.entries(files)) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const browser = await puppeteer.launch({
    channel: 'chrome', executablePath: process.env.CHROME_PATH, headless: true, pipe: true, enableExtensions: true,
    protocolTimeout: 30000,
    args: ['--enable-unsafe-extension-debugging', ...(process.env.CI ? ['--no-sandbox', '--disable-gpu'] : [])],
  });
  try {
    const id = await browser.installExtension(directory);
    const settings = await browser.newPage();
    await settings.goto(`chrome-extension://${id}/options.html`);
    await settings.waitForSelector('#form:not([inert])');
    const shortcut = await settings.evaluate(async () => {
      const commands = await chrome.commands.getAll();
      return commands.find(command => command.name === 'toggle-translation')?.shortcut;
    });
    assert.match(shortcut, /J/i);
    assert.equal(await settings.$eval('#shortcut', el => el.textContent), shortcut);
    await settings.evaluate(() => chrome.storage.local.set({
      settings: { target: 'invalid-target', auto: 'false', parts: { prTitle: false, comments: 'false' } },
    }));
    await settings.reload();
    await settings.waitForSelector('#form:not([inert])');
    assert.deepEqual(await settings.evaluate(() => [
      document.querySelector('#target').selectedIndex >= 0, document.querySelector('#auto').checked,
      document.querySelector('[data-part="prTitle"]').checked, document.querySelector('[data-part="comments"]').checked,
    ]), [true, true, false, true]);
    const commitGroup = 'details:has([data-part="commitTitles"])';
    await settings.focus(commitGroup + ' summary');
    await settings.keyboard.press('Enter');
    await settings.click('[data-part="commitTitles"]');
    assert.equal(await settings.$eval(commitGroup + ' .group-count', el => el.textContent), '1 / 2');
    await settings.select('#target', 'ar');
    await settings.waitForFunction(() => document.documentElement.lang === 'ar');
    assert.equal(await settings.$eval('html', el => el.dir), 'rtl');

    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => request.isNavigationRequest()
      ? request.respond({ contentType: 'text/html', body: '<article class="markdown-body">Hello world</article>' })
      : request.abort());
    // Substitute only the downloadable models. Chrome injects both packaged scripts in their manifest worlds.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'LanguageDetector', { configurable: true, value: {
        create: async () => ({ detect: async () => [{ detectedLanguage: 'en', confidence: 1 }] }),
      } });
      Object.defineProperty(window, 'Translator', { configurable: true, value: {
        create: async ({ targetLanguage }) => ({ translate: async text => targetLanguage + ' ' + text }),
      } });
    });
    await page.goto('https://github.com/example/project/pull/1');
    const clone = '[data-ght-clone]';
    await page.waitForSelector(clone, { visible: true });
    assert.equal(await page.$eval(clone, el => el.textContent), 'ar Hello world');
    await settings.bringToFront();
    await settings.click('#auto');
    await page.bringToFront();
    await page.waitForSelector(clone, { hidden: true });
    assert.equal(await page.$eval('article', el => el.textContent), 'Hello world');
    await settings.bringToFront();
    await settings.reload();
    await settings.waitForSelector('#form:not([inert])');
    assert.equal(await settings.$eval('#auto', el => el.checked), false);
    assert.equal(await settings.$eval('#target', el => el.value), 'ar');
    assert.equal(await settings.$eval('[data-part="commitTitles"]', el => el.checked), false);
  } finally {
    await browser.close();
  }
});
