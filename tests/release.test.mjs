import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { before, test } from 'node:test';
import { unzipSync } from 'fflate';
import { validateRelease } from '../scripts/validate-release.mjs';

let files, options;
before(async () => {
  const root = new URL('../', import.meta.url);
  await promisify(execFile)(process.execPath, ['build.mjs', '--zip'], { cwd: root });
  const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  files = unzipSync(await readFile(new URL(`release/aspid-github-translator-${version}.zip`, root)));
  options = { version, locales: await readdir(new URL('static/_locales/', root)) };
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
