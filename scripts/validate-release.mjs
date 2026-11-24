import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

const text = bytes => new TextDecoder().decode(bytes);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function sourceLocales() {
  const entries = await readdir(new URL('../static/_locales/', import.meta.url), { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
}

export function validateRelease(files, { version, locales }) {
  const required = path => {
    assert.ok(files[path]?.length, `Missing or empty packaged file: ${path}`);
    return files[path];
  };
  const json = path => JSON.parse(text(required(path)));
  for (const path of Object.keys(files)) {
    assert.match(path, /^(?:manifest\.json|LICENSE|(?:background|bridge|content|options)\.js|content\.css|options\.html|icons\/(?:icon-(?:16|32|48|128)\.png|banner-logo\.svg)|fonts\/[\w.-]+\.(?:woff2|css|txt)|_locales\/[\w]+\/messages\.json)$/, `Unexpected packaged file: ${path}`);
  }
  const manifest = json('manifest.json');
  assert.equal(manifest.manifest_version, 3, 'Only Manifest V3 packages are supported');
  assert.equal(manifest.version, version, 'Manifest version must match package.json');
  assert.match(version, /^\d+(?:\.\d+){0,3}$/, 'Invalid Chrome extension version');
  assert.ok(version.split('.').every(value => Number(value) <= 65535 && String(Number(value)) === value)
    && version.split('.').some(value => Number(value) > 0), 'Invalid Chrome extension version');
  assert.equal(manifest.minimum_chrome_version, '138', 'Review browser requirements before changing the minimum version');
  assert.deepEqual(manifest.permissions, ['storage'], 'Review store privacy disclosures before adding permissions');
  assert.ok(!manifest.host_permissions?.length && !manifest.optional_host_permissions?.length
    && !manifest.optional_permissions?.length, 'Unexpected additional permissions');
  required('LICENSE');
  required(manifest.background.service_worker);
  required(manifest.options_ui.page);
  const scripts = manifest.content_scripts;
  assert.equal(scripts.length, 2, 'Expected both translation content scripts');
  const bridge = scripts.find(script => script.world === 'MAIN');
  const content = scripts.find(script => (script.world ?? 'ISOLATED') === 'ISOLATED');
  assert.deepEqual(bridge?.js, ['bridge.js'], 'The translation bridge must run in the MAIN world');
  assert.deepEqual(content?.js, ['content.js'], 'The content script must run in the ISOLATED world');
  assert.deepEqual(content.css, ['content.css'], 'The content script requires its stylesheet');
  for (const script of scripts) {
    assert.deepEqual(script.matches, ['https://github.com/*'], 'Content scripts must only run on github.com');
    for (const path of [...(script.js ?? []), ...(script.css ?? [])]) required(path);
  }
  for (const [size, path] of Object.entries(manifest.icons)) {
    const bytes = Buffer.from(required(path));
    assert.ok(bytes.subarray(0, 8).equals(pngSignature) && bytes.length >= 24, `Invalid PNG: ${path}`);
    assert.equal(bytes.readUInt32BE(16), Number(size), `Wrong icon width: ${path}`);
    assert.equal(bytes.readUInt32BE(20), Number(size), `Wrong icon height: ${path}`);
  }
  for (const path of Object.values(manifest.action.default_icon)) required(path);
  const contentIcon = Buffer.from(required('icons/icon-32.png')).toString('base64');
  assert.ok(text(files['content.css']).includes(`url("data:image/png;base64,${contentIcon}")`),
    'The content stylesheet must embed the packaged 32 px icon');
  required('icons/banner-logo.svg');
  required('fonts/fonts.css');
  for (const [, path] of text(files['fonts/fonts.css']).matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) required(`fonts/${path}`);
  for (const family of ['sans', 'serif', 'mono']) required(`fonts/ibm-plex-${family}-LICENSE.txt`);

  const base = json(`_locales/${manifest.default_locale}/messages.json`);
  const keys = Object.keys(base).sort();
  const packagedLocales = Object.keys(files).filter(path => /^_locales\/[^/]+\/messages\.json$/.test(path))
    .map(path => path.split('/')[1]).sort();
  assert.deepEqual(packagedLocales, [...locales].sort(), 'Packaged locales differ from the source locales');
  const localizedManifestKeys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map(match => match[1]);
  for (const locale of packagedLocales) {
    const messages = json(`_locales/${locale}/messages.json`);
    assert.deepEqual(Object.keys(messages).sort(), keys, `${locale}: locale keys differ from the default locale`);
    for (const [key, entry] of Object.entries(messages)) {
      assert.ok(typeof entry.message === 'string' && entry.message.trim(), `${locale}/${key}: empty message`);
      const placeholders = Object.keys(entry.placeholders ?? {}).sort();
      assert.deepEqual(placeholders, Object.keys(base[key].placeholders ?? {}).sort(), `${locale}/${key}: placeholder definitions differ`);
      for (const name of placeholders) {
        assert.equal(entry.placeholders[name].content, base[key].placeholders[name].content, `${locale}/${key}: placeholder substitution differs`);
      }
      const named = value => [...value.matchAll(/\$([a-z][\w]*)\$/gi)].map(match => match[1].toLowerCase()).sort();
      assert.deepEqual(named(entry.message), named(base[key].message), `${locale}/${key}: message placeholders differ`);
    }
    for (const key of localizedManifestKeys) assert.ok(messages[key], `${locale}: missing manifest message ${key}`);
    assert.ok(messages.extName.message.length <= 75, `${locale}: extension name exceeds 75 characters`);
    assert.ok(messages.extDescription.message.length <= 132, `${locale}: description exceeds 132 characters`);
  }
  return { version, files: Object.keys(files).length, locales: packagedLocales.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { name, version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const archive = process.argv[2] ?? `release/${name}-${version}.zip`;
  const locales = await sourceLocales();
  const result = validateRelease(unzipSync(await readFile(archive)), { version, locales });
  console.log(`Validated ${archive}: version ${result.version}, ${result.files} files, ${result.locales} locales`);
}
