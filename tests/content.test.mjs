import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

let browser;
const origin = 'https://github.com';
const root = new URL('../', import.meta.url);
const messages = JSON.parse(await readFile(new URL('static/_locales/en/messages.json', root), 'utf8'));
const css = await readFile(new URL('static/content.css', root), 'utf8');

before(async () => {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
});
after(async () => browser?.close());

async function fixture(body, { path = '/owner/repo/pull/1', mode = 'ready', auto = true, detector = 'en', cld = 'en', parts } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (url.origin !== origin) return request.abort();
    if (url.pathname.startsWith('/__asp__/src/')) {
      const source = url.pathname.slice('/__asp__/'.length);
      return request.respond({ status: 200, contentType: 'text/javascript', body: await readFile(new URL(source, root), 'utf8') });
    }
    if (request.isNavigationRequest()) {
      return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px sans-serif} .comment-reactions{display:flex;align-items:center} [hidden]{display:none!important} ${css}</style></head><body>${body}</body></html>` });
    }
    return request.abort();
  });
  await page.goto(origin + path);
  await page.evaluate(({ messages, mode, auto, detector, cld, parts }) => {
    window.__engineMode = mode;
    window.__settings = { target: 'ru', auto, ...(parts && { parts }) };
    window.__storageListeners = [];
    window.__requests = [];
    window.__translationSources = [];
    window.__cldCalls = 0;
    chrome.storage = {
      local: { get: async () => ({ settings: window.__settings }) },
      onChanged: { addListener: listener => window.__storageListeners.push(listener) },
    };
    chrome.i18n = {
      getUILanguage: () => 'en',
      detectLanguage: async () => {
        window.__cldCalls++;
        return { isReliable: true, languages: [{ language: cld, percentage: 100 }] };
      },
      getMessage: (key, substitutions = []) => {
        const entry = messages[key];
        if (!entry) return '';
        return entry.message.replace(/\$(\w+)\$/g, (match, name) => entry.placeholders?.[name.toLowerCase()]?.content ?? match)
          .replace(/\$([1-9])/g, (_, index) => substitutions[index - 1] ?? '');
      },
    };
    window.addEventListener('ght:req', event => {
      const { id, op, args } = JSON.parse(event.detail);
      window.__requests.push(op);
      let result, error, code;
      if (op === 'detector.detect') {
        if (detector === 'unavailable') error = 'Detector model unavailable';
        else result = [{ lang: args.text.includes('Already Russian') ? 'ru' : detector, confidence: 1 }];
      }
      else if (op === 'translator.prepare') {
        if (window.__engineMode === 'download-error') error = 'Download failed';
        else window.__engineMode = 'ready';
      } else if (op === 'translator.translate') {
        window.__translationSources.push(args.source);
        if (args.source === 'be') {
          error = 'Unsupported language pair';
          code = 'NotSupportedError';
        } else if (['activation', 'download-error'].includes(window.__engineMode)) {
          error = 'Activation needed';
          code = 'activation';
        } else if (window.__engineMode === 'error') error = 'Translation failed';
        else result = args.texts.map(text => text.replaceAll('Hello', 'Привет').replaceAll('use shared', 'использовать общие').replaceAll('is a powerful', '— мощный'));
      }
      window.dispatchEvent(new CustomEvent('ght:res', { detail: JSON.stringify({ id, result, error, code }) }));
    });
  }, { messages, mode, auto, detector, cld, parts });
  await page.evaluate(() => import('/__asp__/src/content.js'));
  async function settled() {
    await page.waitForFunction(() => {
      const fab = document.querySelector('.ght-fab');
      return fab && !fab.textContent.includes('Translating');
    });
    assert.deepEqual(errors, []);
  }
  await page.waitForSelector('.ght-fab');
  return { page, settled, errors };
}

const title = '<div class="titleWithAction"><h1><span class="markdown-title">Hello title</span></h1><button id="edit">Edit</button></div>';
const comment = (id = 'pullrequest-1', text = 'Hello description') => `<div class="js-comment" id="${id}"><div class="markdown-body"><p>${text}</p><code>SomeCode()</code></div><div class="comment-reactions"><form><button type="button" class="smile">Smile</button></form></div></div>`;
const timeline = `<div class="js-details-container" id="timeline-commit"><div class="d-flex"><div class="title"><code><a class="markdown-title" href="#commit">Hello commit</a></code><button id="expand">…</button></div><div id="verified">Verified</div><div>✓</div></div><div class="Details-content--hidden" hidden><pre>Hello commit body</pre></div></div>`;
const row = id => `<li data-testid="commit-row-item" id="${id}"><div data-listview-item-title-container><h4><a href="#${id}"><span>Hello ${id}</span></a></h4></div><div><div class="extended-commit-description-container">Hello body</div></div><div class="metadata"><span class="verified">Verified</span><div class="primary d-none d-sm-flex"><a data-testid="commit-row-browse-repo" href="#browse">Browse</a></div></div></li>`;

test('comment controls sit after reactions; global actions reset local choices and synchronize both PR headings', async () => {
  const { page, settled } = await fixture(title + '<h2 class="PageHeader-Title"><a><span class="markdown-title">Hello title</span></a></h2>' + comment());
  try {
    await page.waitForSelector('#pullrequest-1 .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$eval('.ght-fab', el => el.textContent), '🌐 Show all originals');
    assert.equal(await page.$$eval('.ght-label', els => els.length), 0);
    assert.equal(await page.$$eval('.titleWithAction .ght-toggle', els => els.length), 1);
    assert.equal(await page.$eval('#pullrequest-1 .ght-toggle', el => el.closest('form') === null && el.closest('.comment-reactions') !== null), true);
    await page.click('#pullrequest-1 .ght-toggle');
    assert.equal(await page.$eval('#pullrequest-1 .markdown-body', el => el.hasAttribute('data-ght-hidden')), false);
    await page.click('.titleWithAction .ght-toggle');
    assert.equal(await page.$$eval('.markdown-title:not([data-ght-clone])', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    await page.click('.ght-fab');
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    assert.equal(await page.$eval('#pullrequest-1 code', el => el.textContent), 'SomeCode()');
  } finally { await page.close(); }
});

test('one commit button preserves local choice when its collapsed body translates later', async () => {
  const { page, settled } = await fixture(timeline);
  try {
    await page.waitForSelector('#timeline-commit .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$eval('#verified', el => el.previousElementSibling.classList.contains('ght-control-slot')), true);
    await page.click('#timeline-commit .ght-toggle');
    await page.evaluate(() => { document.querySelector('.Details-content--hidden').hidden = false; });
    await page.waitForFunction(() => document.querySelector('.Details-content--hidden [data-ght-clone]'));
    await settled();
    assert.equal(await page.$$eval('#timeline-commit .ght-toggle', els => els.length), 1);
    assert.equal(await page.$eval('.Details-content--hidden pre', el => el.hasAttribute('data-ght-hidden')), false);
    assert.equal(await page.$eval('.Details-content--hidden [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), true);
    await page.click('#timeline-commit .ght-toggle');
    assert.equal(await page.$$eval('#timeline-commit [data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('commit list buttons affect only their own row and sit before metadata', async () => {
  const { page, settled } = await fixture(`<ul>${row('first')}${row('second')}</ul>`, { path: '/owner/repo/pull/1/commits' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 2);
    await settled();
    assert.equal(await page.$eval('#first .metadata', el => el.firstElementChild.classList.contains('ght-control-slot')), true);
    await page.addStyleTag({ content: '@media(max-width:640px){.d-none.d-sm-flex{display:none}}' });
    await page.setViewport({ width: 390, height: 900 });
    assert.equal(await page.$eval('#first .ght-toggle', el => el.getBoundingClientRect().width > 0), true);
    await page.click('#first .ght-toggle');
    assert.equal(await page.$$eval('#first [data-ght-clone]', els => els.every(el => el.hasAttribute('data-ght-hidden'))), true);
    assert.equal(await page.$$eval('#second [data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    await page.click('.ght-fab');
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('README control uses its header, restores anchors, and survives a replaced header', async () => {
  const { page, settled } = await fixture('<div id="repository-readme"><div class="header"><nav><span class="octicon-book"></span>README</nav><div class="readmeHeaderSlot"></div><button>Outline</button></div><div><article itemprop="text" class="markdown-body"><h1 id="hello">Hello README</h1></article></div></div>', { path: '/owner/repo' });
  try {
    await page.waitForSelector('.header .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$$eval('#hello', els => els.length), 1);
    assert.equal(await page.$eval('#hello', el => Boolean(el.closest('[data-ght-clone]'))), true);
    await page.click('.header .ght-toggle');
    assert.equal(await page.$eval('#hello', el => Boolean(el.closest('[data-ght-clone]'))), false);
    await page.evaluate(() => { document.querySelector('.header').outerHTML = '<div class="header"><nav><span class="octicon-book"></span>README</nav><div class="readmeHeaderSlot"></div><button>Outline</button></div>'; });
    await page.waitForSelector('.header .ght-toggle[data-state="done"]');
    assert.equal(await page.$eval('.header .ght-toggle', el => el.getAttribute('aria-pressed')), 'true');
  } finally { await page.close(); }
});

test('file control precedes raw actions and disappears in Code or Blame without changing source', async () => {
  const { page, settled } = await fixture('<div class="blobContainer"><header><div data-component="SegmentedControl.Button"><button id="preview" aria-pressed="true"><span data-text="Preview">Preview</span></button></div><div class="actions"><div class="react-blob-header-edit-and-raw-actions"><a>Raw</a></div></div></header><section id="preview-content"><article itemprop="text" class="markdown-body">Hello document</article></section><pre class="js-file-content" id="source" hidden>Hello source code</pre></div>', { path: '/owner/repo/blob/main/AGENTS.md' });
  try {
    await page.waitForSelector('.actions .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$eval('.actions', el => el.firstElementChild.classList.contains('ght-control-slot')), true);
    await page.click('.actions .ght-toggle');
    await page.evaluate(() => { document.querySelector('#preview').setAttribute('aria-pressed', 'false'); document.querySelector('#preview-content').hidden = true; document.querySelector('#source').hidden = false; });
    await page.waitForFunction(() => document.querySelector('.ght-control-slot').hidden);
    assert.equal(await page.$eval('#source', el => el.textContent), 'Hello source code');
    await page.evaluate(() => { document.querySelector('#preview').setAttribute('aria-pressed', 'true'); document.querySelector('#preview-content').hidden = false; document.querySelector('#source').hidden = true; });
    await page.waitForFunction(() => !document.querySelector('.ght-control-slot').hidden);
    assert.equal(await page.$eval('.actions .ght-toggle', el => el.getAttribute('aria-pressed')), 'true');
  } finally { await page.close(); }
});

test('translation and model download failures are recoverable through the same local button', async () => {
  for (const mode of ['error', 'download-error']) {
    const { page, settled } = await fixture(comment(), { mode });
    try {
      await page.waitForSelector(mode === 'error' ? '.ght-toggle[data-state="error"]' : '.ght-toggle[data-state="activation"]');
      await settled();
      assert.equal(await page.$$eval('.ght-label', els => els.length), 0);
      if (mode === 'download-error') {
        await page.click('.ght-toggle');
        await page.waitForFunction(() => document.querySelector('.ght-toggle').title.includes('Could not download'));
      }
      await page.evaluate(() => { window.__engineMode = 'ready'; });
      await page.click('.ght-toggle');
      await page.waitForSelector('.ght-toggle[data-state="done"]');
      await settled();
      assert.equal(await page.$eval('.ght-toggle', el => el.disabled), false);
    } finally { await page.close(); }
  }
});

test('edited and removed comments update controls; disabling a part restores original content and cleans UI', async () => {
  const { page, settled } = await fixture(comment() + comment('issuecomment-2', 'Hello second'));
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 2);
    await settled();
    await page.evaluate(() => { document.querySelector('#pullrequest-1 .markdown-body p').textContent = 'Hello edited description'; });
    await page.waitForFunction(() => document.querySelector('#pullrequest-1 [data-ght-clone]')?.textContent.includes('Привет edited'));
    assert.equal(await page.$$eval('#pullrequest-1 .ght-toggle', els => els.length), 1);
    await page.evaluate(() => document.querySelector('#issuecomment-2').remove());
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle').length === 1);
    await page.evaluate(() => {
      window.__settings = { ...window.__settings, parts: { prBody: false } };
      for (const listener of window.__storageListeners) listener({ settings: {} }, 'local');
    });
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle, [data-ght-clone]').length === 0);
    assert.equal(await page.$eval('.markdown-body', el => el.hasAttribute('data-ght-hidden')), false);
    assert.deepEqual(await page.evaluate(() => document.querySelectorAll('[data-ght-ui]').length), 0);
  } finally { await page.close(); }
});

test('manual mode starts from the global button; untranslated text has no local control', async () => {
  const { page, settled } = await fixture(comment('pullrequest-1', 'Already Russian'), { auto: false });
  try {
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
    assert.equal(await page.$eval('.ght-fab', el => el.textContent), '🌐 Translate');
    await page.click('.ght-fab');
    await settled();
    await page.waitForFunction(() => window.__requests.includes('detector.detect'));
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length), 0);
  } finally { await page.close(); }
});

test('a newly rendered commit body inherits the existing local choice', async () => {
  const { page, settled } = await fixture(`<ul>${row('first')}</ul>`);
  try {
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    await settled();
    await page.click('.ght-toggle');
    await page.evaluate(() => {
      const body = document.querySelector('.extended-commit-description-container');
      body.insertAdjacentHTML('afterend', '<pre class="extended-commit-description-container" id="late-body">Hello late body</pre>');
    });
    await page.waitForFunction(() => document.querySelector('#late-body').nextElementSibling?.hasAttribute('data-ght-clone'));
    assert.equal(await page.$eval('#late-body', el => el.hasAttribute('data-ght-hidden')), false);
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 1);
  } finally { await page.close(); }
});

test('classic review comments place their fallback footer outside the table, and navigation removes all translation UI', async () => {
  const { page, settled } = await fixture('<div class="review-comment"><table><tbody><tr><td class="markdown-body">Hello review</td></tr></tbody></table></div>');
  try {
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$eval('.ght-control-footer', el => el.parentElement.classList.contains('review-comment') && el.previousElementSibling.tagName === 'TABLE'), true);
    await page.click('.ght-toggle');
    await page.evaluate(() => { history.pushState({}, '', '/owner/repo/issues/1'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForFunction(() => !document.querySelector('.ght-toggle, .ght-fab, [data-ght-clone], [data-ght-ui]'));
    assert.equal(await page.$eval('.markdown-body', el => el.hasAttribute('data-ght-hidden')), false);
  } finally { await page.close(); }
});

test('every supported UI locale provides both page-wide commands', async () => {
  for (const locale of await readdir(new URL('static/_locales/', root))) {
    const table = JSON.parse(await readFile(new URL(`static/_locales/${locale}/messages.json`, root), 'utf8'));
    assert.ok(table.fabShowOriginals?.message, `${locale}: missing original command`);
    assert.ok(table.fabTranslateAll?.message, `${locale}: missing translation command`);
    assert.ok(table.partAbout?.message, `${locale}: missing About label`);
    assert.ok(table.settingsGroupRepository?.message, `${locale}: missing repository group`);
  }
});

test('a long reaction row wraps the translation button without overflow on narrow screens', async () => {
  const { page, settled } = await fixture(comment());
  try {
    await page.setViewport({ width: 320, height: 900 });
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    await settled();
    await page.addStyleTag({ content: '.comment-reactions form{display:flex;flex-wrap:wrap;gap:6px} .smile{width:40px}' });
    await page.evaluate(() => {
      document.querySelector('.comment-reactions form').insertAdjacentHTML('beforeend', '<button type="button">👍 12</button><button type="button">❤️ 42</button><button type="button">🎉 17</button>');
    });
    assert.equal(await page.$eval('.comment-reactions', el => {
      const container = el.getBoundingClientRect();
      const button = el.querySelector('.ght-toggle').getBoundingClientRect();
      const reactions = el.querySelector('form').getBoundingClientRect();
      return button.right <= container.right && button.left >= container.left && button.top >= reactions.bottom;
    }), true);
  } finally { await page.close(); }
});

test('a Belarusian guess for an English commit is corrected before translation', async () => {
  const { page, settled } = await fixture(timeline.replace('Hello commit</a>', 'docs: use shared MVVM README artwork</a>'), { detector: 'be', cld: 'en' });
  try {
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    await settled();
    assert.deepEqual(await page.evaluate(() => window.__translationSources), ['en']);
    assert.equal(await page.evaluate(() => window.__cldCalls), 1);
    assert.equal(await page.$$eval('.ght-toggle[data-state="error"]', els => els.length), 0);
    assert.match(await page.$eval('[data-ght-clone]', el => el.textContent), /docs: использовать общие MVVM README artwork/);
  } finally { await page.close(); }
});

test('CLD Cyrillic guesses are rejected for Latin text when the downloaded detector is unavailable', async () => {
  const { page, settled } = await fixture(timeline, { detector: 'unavailable', cld: 'be' });
  try {
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    await settled();
    assert.deepEqual(await page.evaluate(() => window.__translationSources), ['en']);
  } finally { await page.close(); }
});

test('an unsupported guess for already Russian text is checked independently rather than translated as Belarusian', async () => {
  const { page, settled } = await fixture(comment('pullrequest-1', 'Текст уже написан по-русски'), { detector: 'be', cld: 'ru' });
  try {
    await settled();
    await page.waitForFunction(() => window.__cldCalls > 0);
    assert.deepEqual(await page.evaluate(() => window.__translationSources), []);
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
  } finally { await page.close(); }
});

test('genuine unsupported Cyrillic text is not silently reinterpreted as English', async () => {
  const { page, settled } = await fixture(comment('pullrequest-1', 'Прывітанне, гэта беларускі тэкст'), { detector: 'be', cld: 'be' });
  try {
    await page.waitForSelector('.ght-toggle[data-state="error"]');
    await settled();
    assert.deepEqual(await page.evaluate(() => window.__translationSources), ['be']);
    assert.match(await page.$eval('.ght-toggle', el => el.title), /Belarusian/);
  } finally { await page.close(); }
});

test('script validation accepts Japanese, Korean and traditional Chinese detector results', async () => {
  for (const [detector, sample] of [['ja', 'Hello 日本語'], ['ko', 'Hello 한국어'], ['zh-Hant', 'Hello 中文']]) {
    const { page, settled } = await fixture(comment('pullrequest-1', sample), { detector });
    try {
      await page.waitForSelector('.ght-toggle[data-state="done"]');
      await settled();
      assert.deepEqual(await page.evaluate(() => window.__translationSources), [detector]);
      assert.equal(await page.evaluate(() => window.__cldCalls), 0);
    } finally { await page.close(); }
  }
});

const directoryRow = (id, message = 'feat(scope)!: Hello file (#304)') => `<tr class="react-directory-row" id="${id}"><td class="react-directory-row-name-cell-large-screen"><a href="/owner/repo/blob/main/${id}">${id}</a></td><td class="react-directory-row-commit-cell"><div class="truncate"><a class="commit-link" href="/owner/repo/commit/1234567" title="${message}">${message}</a></div></td><td><relative-time datetime="2026-11-01">2 weeks ago</relative-time></td></tr>`;
const directory = `<div id="directory"><div id="directory-header"><div class="latest"><a class="author" href="/author">Author</a><a id="latest-message" href="/owner/repo/commit/1234567">Hello latest commit</a></div><div data-testid="latest-commit-details"><a href="/owner/repo/commit/1234567">1234567</a><relative-time>last week</relative-time></div><div class="history"><a class="history-desktop" href="/owner/repo/commits/main"><span class="octicon-history"></span>1,513 Commits</a><div class="history-mobile"><a href="/owner/repo/commits/main">History</a></div></div></div><div data-testid="directory-content"><table aria-labelledby="folders-and-files"><tbody>${directoryRow('README.md')}${directoryRow('src')}</tbody></table></div></div>`;
const readme = '<div id="readme"><div class="Box-header">README</div><article class="markdown-body" itemprop="text">Hello README</article></div>';

test('one header button switches all directory messages, independently from README; global commands reset both', async () => {
  const { page, settled } = await fixture(directory + readme, { path: '/owner/repo' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 2);
    await settled();
    assert.equal(await page.$$eval('#directory .ght-toggle', els => els.length), 1);
    assert.equal(await page.$eval('.history-desktop', el => el.previousElementSibling.classList.contains('ght-control-slot')), true);
    assert.equal(await page.$$eval('.react-directory-row .ght-toggle', els => els.length), 0);
    assert.equal(await page.$$eval('#directory [data-ght-clone]', els => els.length), 3);
    assert.match(await page.$eval('#README\\.md .react-directory-row-commit-cell [data-ght-clone]', el => el.textContent), /^feat\(scope\)!: Привет file \(#304\)$/);
    assert.match(await page.$eval('#latest-message + [data-ght-clone]', el => el.title), /Hello latest commit/);
    const preserved = await page.$$eval('#directory .react-directory-row', els => els.map(el => ({ name: el.querySelector('td a').textContent, date: el.querySelector('relative-time').textContent })));
    assert.deepEqual(preserved, [{ name: 'README.md', date: '2 weeks ago' }, { name: 'src', date: '2 weeks ago' }]);
    assert.equal(await page.$eval('[data-testid="latest-commit-details"]', el => el.textContent), '1234567last week');
    await page.click('#directory-header .ght-toggle');
    assert.equal(await page.$$eval('#directory [data-ght-clone]', els => els.every(el => el.hasAttribute('data-ght-hidden'))), true);
    assert.equal(await page.$eval('#readme [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), false);
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => el.hasAttribute('data-ght-hidden'))), true);
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    assert.equal(await page.$$eval('#directory-header .author[data-ght-hidden], [data-testid="latest-commit-details"] [data-ght-hidden]', els => els.length), 0);
  } finally { await page.close(); }
});

test('directory-only folder pages offer manual translation even when README translation is disabled', async () => {
  const { page, settled } = await fixture(directory, { path: '/owner/repo/tree/main/src', auto: false, parts: { readme: false } });
  try {
    assert.equal(await page.$eval('.ght-fab', el => el.textContent), '🌐 Translate');
    await page.click('.ght-fab');
    await page.waitForSelector('#directory-header .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length), 3);
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 1);
  } finally { await page.close(); }
});

test('late directory rows inherit table selection, a replaced header receives one button, and the button remains visible on narrow screens', async () => {
  const { page, settled } = await fixture(directory, { path: '/owner/repo' });
  try {
    await page.waitForSelector('#directory-header .ght-toggle[data-state="done"]');
    await settled();
    await page.click('#directory-header .ght-toggle');
    await page.evaluate(html => document.querySelector('tbody').insertAdjacentHTML('beforeend', html), directoryRow('late.js', 'Hello new commit'));
    await page.waitForFunction(() => document.querySelector('#late\\.js [data-ght-clone]'));
    assert.equal(await page.$eval('#late\\.js [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), true);
    await page.evaluate(() => {
      const header = document.querySelector('#directory-header');
      header.outerHTML = '<div id="directory-header"><a href="/owner/repo/commit/1234567">Hello refreshed commit</a><div data-testid="latest-commit-details"></div><div class="history"><a class="history-desktop" href="/owner/repo/commits/main"><span class="octicon-history"></span>1,513 Commits</a><div class="history-mobile"><a href="/owner/repo/commits/main">History</a></div></div></div>';
    });
    await page.waitForSelector('#directory-header .ght-toggle[data-state="done"]');
    assert.equal(await page.$eval('#directory-header .ght-toggle', el => el.getAttribute('aria-pressed')), 'true');
    assert.equal(await page.$$eval('#directory .ght-toggle', els => els.length), 1);
    await page.addStyleTag({ content: '.history{display:flex;align-items:center}.history-mobile{display:none}@media(max-width:640px){.history-desktop{display:none}.history-mobile{display:block}}' });
    await page.setViewport({ width: 390, height: 900 });
    assert.equal(await page.$eval('#directory-header .ght-toggle', el => el.getBoundingClientRect().width > 0), true);
    await page.click('#directory-header .ght-toggle');
    assert.equal(await page.$$eval('#directory [data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('disabling commit titles removes table translations and its control while leaving README translated', async () => {
  const { page, settled } = await fixture(directory + readme, { path: '/owner/repo' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 2);
    await settled();
    await page.evaluate(() => {
      window.__settings.parts = { commitTitles: false };
      for (const listener of window.__storageListeners) listener({ settings: {} }, 'local');
    });
    await page.waitForFunction(() => !document.querySelector('#directory [data-ght-clone], #directory .ght-toggle'));
    await page.waitForSelector('#readme .ght-toggle[data-state="done"]');
    assert.equal(await page.$$eval('#directory [data-ght-hidden]', els => els.length), 0);
    assert.equal(await page.$$eval('#readme [data-ght-clone]', els => els.length), 1);
  } finally { await page.close(); }
});

const prActionHeader = `<div id="pr-header" data-component="PageHeader"><div data-component="TitleArea"><div class="titleWithAction"><h1><span class="markdown-title">docs(website): Hello Ko-fi donation card and a Sponsor button</span></h1><span class="titleSuffix">#562</span><button id="edit">Edit</button></div></div><div data-component="PH_Actions"><a id="overview" href="#overview">Try the Overview page</a><button>Merge status</button><button>Code</button></div></div><h2 class="PageHeader-Title"><a><span class="markdown-title">docs(website): Hello Ko-fi donation card and a Sponsor button</span></a></h2>`;
const prHeaderLayout = `[data-component="PageHeader"]{display:grid;grid-template-areas:"title-area actions";grid-template-columns:minmax(0,1fr) auto;gap:12px}[data-component="TitleArea"]{grid-area:title-area;min-width:0}.titleWithAction h1{display:inline;font-size:24px;font-weight:400;margin:0}.titleSuffix{font-size:24px;color:gray}[data-component="PH_Actions"]{grid-area:actions;display:flex;align-items:center;gap:8px;align-self:start;height:32px}[data-component="PH_Actions"]>a,[data-component="PH_Actions"]>button{font-size:12px;white-space:nowrap}@media(max-width:640px){[data-component="PageHeader"]{--grid-row-order-actions:1;grid-template-areas:"actions" "title-area";grid-template-columns:minmax(0,1fr)}[data-component="PH_Actions"]{flex-wrap:wrap;height:auto;justify-content:flex-end;grid-row:var(--grid-row-order-actions)}}`;

test('PR title button sits before Overview in the actions row, with a square GitHub-style shape', async () => {
  const { page, settled } = await fixture(prActionHeader);
  try {
    await page.addStyleTag({ content: prHeaderLayout });
    await page.waitForSelector('[data-component="PH_Actions"] .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$$eval('.titleWithAction .ght-toggle', els => els.length), 0);
    assert.equal(await page.$eval('#overview', el => el.previousElementSibling.classList.contains('ght-control-title')), true);
    assert.equal(await page.$$eval('.ght-control-title', els => els.length), 1);
    const style = await page.$eval('.ght-control-title .ght-toggle', el => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height, radius: getComputedStyle(el).borderRadius };
    });
    assert.deepEqual(style, { width: 32, height: 32, radius: '6px' });
    await page.click('.ght-control-title .ght-toggle');
    assert.equal(await page.$$eval('.markdown-title:not([data-ght-clone])', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    await page.click('.ght-fab');
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('.markdown-title[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('title control survives hidden, loaded and replaced native actions without revealing hidden GitHub controls', async () => {
  const { page, settled } = await fixture(prActionHeader.replace('data-component="PH_Actions"', 'data-component="PH_Actions" hidden'));
  try {
    await page.addStyleTag({ content: prHeaderLayout });
    await page.waitForSelector('.ght-control-title-standalone .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$eval('[data-component="PH_Actions"]', el => el.hidden), true);
    assert.equal(await page.$eval('.ght-control-title', el => el.parentElement.dataset.component), 'PageHeader');
    await page.click('.ght-control-title .ght-toggle');
    await page.evaluate(() => { document.querySelector('[data-component="PH_Actions"]').hidden = false; });
    await page.waitForSelector('[data-component="PH_Actions"] .ght-toggle');
    assert.equal(await page.$$eval('.ght-control-title-standalone', els => els.length), 0);
    await page.evaluate(() => {
      document.querySelector('[data-component="PH_Actions"]').outerHTML = '<div data-component="PH_Actions"><a id="overview" href="#overview">Try the Overview page</a><button>Merge status</button><button>Code</button></div>';
    });
    await page.waitForSelector('[data-component="PH_Actions"] .ght-toggle');
    assert.equal(await page.$$eval('.ght-control-title', els => els.length), 1);
    assert.equal(await page.$eval('.ght-control-title .ght-toggle', el => el.getAttribute('aria-pressed')), 'true');
  } finally { await page.close(); }
});

test('long PR titles and the translation action remain separate at desktop and narrow widths', async () => {
  const { page, settled } = await fixture(prActionHeader);
  try {
    await page.addStyleTag({ content: prHeaderLayout });
    await page.waitForSelector('[data-component="PH_Actions"] .ght-toggle[data-state="done"]');
    await settled();
    for (const width of [1280, 728, 390, 320]) {
      await page.setViewport({ width, height: 900 });
      const layout = await page.evaluate(() => {
        const title = document.querySelector('[data-component="TitleArea"]').getBoundingClientRect();
        const button = document.querySelector('.ght-control-title .ght-toggle').getBoundingClientRect();
        const actions = document.querySelector('[data-component="PH_Actions"]').getBoundingClientRect();
        return {
          visible: button.width > 0 && button.height > 0,
          overlapsTitle: button.left < title.right && button.right > title.left && button.top < title.bottom && button.bottom > title.top,
          insideRow: button.left >= actions.left && button.right <= actions.right,
          fits: button.left >= 0 && button.right <= window.innerWidth,
        };
      });
      assert.deepEqual(layout, { visible: true, overlapsTitle: false, insideRow: true, fits: true }, `width ${width}`);
    }
  } finally { await page.close(); }
});

test('the PR title action keeps a square 44px touch target', async () => {
  const { page, settled } = await fixture(prActionHeader);
  try {
    await page.addStyleTag({ content: prHeaderLayout });
    await page.waitForSelector('[data-component="PH_Actions"] .ght-toggle[data-state="done"]');
    await settled();
    const session = await page.createCDPSession();
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    assert.deepEqual(await page.$eval('.ght-control-title .ght-toggle', el => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }), { width: 44, height: 44 });
    await session.detach();
  } finally { await page.close(); }
});

const aboutDescription = 'Aspid.MVVM is a powerful, high-performance MVVM framework for Unity.';
const aboutSection = `<div id="about" class="sidebarSection__test"><h2><span>About</span><button id="edit-about" type="button">Settings</button></h2><p class="description__test">${aboutDescription}</p><div class="websiteRow"><a id="website" href="https://vpd-inc.gitbook.io/aspid.mvvm/">vpd-inc.gitbook.io/aspid.mvvm/</a></div><div class="topics"><a href="/topics/unity">unity</a><a href="/topics/mvvm">mvvm</a></div></div>`;

test('About translates independently with a header button, preserving names, website, topics and native settings', async () => {
  const { page, settled } = await fixture(aboutSection + readme, { path: '/owner/repo' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 2);
    await settled();
    assert.equal(await page.$eval('#edit-about', el => el.previousElementSibling.classList.contains('ght-control-about')), true);
    assert.match(await page.$eval('#about [data-ght-clone]', el => el.textContent), /^Aspid\.MVVM — мощный.*MVVM framework for Unity\.$/);
    const metadata = await page.$eval('#about', el => ({
      heading: el.querySelector('h2 > span').textContent,
      website: el.querySelector('#website').textContent,
      url: el.querySelector('#website').href,
      topics: [...el.querySelectorAll('.topics a')].map(a => a.textContent),
      editable: !el.querySelector('#edit-about').disabled,
    }));
    assert.deepEqual(metadata, { heading: 'About', website: 'vpd-inc.gitbook.io/aspid.mvvm/', url: 'https://vpd-inc.gitbook.io/aspid.mvvm/', topics: ['unity', 'mvvm'], editable: true });
    await page.click('#about .ght-toggle');
    assert.equal(await page.$eval('#about [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), true);
    assert.equal(await page.$eval('#readme [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), false);
    await page.click('.ght-fab');
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('About-only pages support manual translation with other repository parts disabled; saved settings inherit the new part', async () => {
  const { page, settled } = await fixture(aboutSection, { path: '/owner/repo', auto: false, parts: { readme: false, commitTitles: false } });
  try {
    const settings = await page.evaluate(async () => (await import('/__asp__/src/settings.js')).loadSettings());
    assert.equal(settings.parts.about, true);
    await page.click('.ght-fab');
    await page.waitForSelector('#about .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length), 1);
  } finally { await page.close(); }
});

test('About supports classic markup and edited descriptions; disabling its setting restores the original', async () => {
  const { page, settled } = await fixture('<div id="about" class="BorderGrid-cell"><h2>About</h2><p class="f4 my-3">Hello description</p><a href="https://example.com">example.com</a></div>' + readme, { path: '/owner/repo' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 2);
    await settled();
    await page.evaluate(() => { document.querySelector('#about p:not([data-ght-clone])').textContent = 'Hello edited description'; });
    await page.waitForFunction(() => document.querySelector('#about [data-ght-clone]')?.textContent.includes('Привет edited'));
    assert.equal(await page.$$eval('#about .ght-toggle', els => els.length), 1);
    await page.evaluate(() => {
      window.__settings.parts = { about: false };
      for (const listener of window.__storageListeners) listener({ settings: {} }, 'local');
    });
    await page.waitForFunction(() => !document.querySelector('#about .ght-toggle, #about [data-ght-clone]'));
    await page.waitForSelector('#readme .ght-toggle[data-state="done"]');
    assert.equal(await page.$eval('#about p', el => el.textContent), 'Hello edited description');
    assert.equal(await page.$eval('#about p', el => el.hasAttribute('data-ght-hidden')), false);
  } finally { await page.close(); }
});

test('translation settings have exactly one switch for each part, including About', async () => {
  const { page } = await fixture(aboutSection, { path: '/owner/repo', auto: false });
  try {
    const parts = await page.evaluate(async () => (await import('/__asp__/src/settings.js')).PARTS);
    const html = await readFile(new URL('static/options.html', root), 'utf8');
    const switches = [...html.matchAll(/data-part="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(switches).size, switches.length);
    assert.deepEqual(switches.sort(), [...parts].sort());
  } finally { await page.close(); }
});

const singleCommit = '<div data-component="PageHeader"><div data-component="TitleArea"><h1>Commit c3cc252</h1></div><div data-component="PH_Actions"><div class="commit-actions"><a class="browseFilesButton__test" href="/owner/repo/tree/c3cc252">Browse files</a></div></div></div><div id="commit-card"><div class="commitMessageContainer__test"><span>Hello CLAUDE.md and AGENTS.md</span><span class="extended-commit-description-container">Hello full commit description</span></div><div id="commit-meta">main · c3cc252</div></div>';

test('single-commit translation control sits beside Browse files and switches the title and body together', async () => {
  const { page, settled } = await fixture(singleCommit, { path: '/owner/repo/commit/c3cc252' });
  try {
    await page.waitForSelector('[data-component="PH_Actions"] .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$$eval('#commit-card .ght-toggle', els => els.length), 0);
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 1);
    assert.equal(await page.$eval('[data-component="PH_Actions"]', el => el.firstElementChild.classList.contains('ght-control-header')), true);
    assert.equal(await page.$eval('.ght-toggle', el => getComputedStyle(el).borderRadius), '6px');
    await page.click('.ght-toggle');
    assert.equal(await page.$$eval('#commit-card [data-ght-clone]', els => els.length === 2 && els.every(el => el.hasAttribute('data-ght-hidden'))), true);
    await page.click('.ght-fab');
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('#commit-card [data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    assert.equal(await page.$eval('#commit-meta', el => el.textContent), 'main · c3cc252');
  } finally { await page.close(); }
});

test('single-commit controls start in a footer and move to the loaded header without losing local choice', async () => {
  const header = singleCommit.slice(0, singleCommit.indexOf('<div id="commit-card">'));
  const body = singleCommit.slice(singleCommit.indexOf('<div id="commit-card">'));
  const { page, settled } = await fixture(body, { path: '/owner/repo/commit/c3cc252' });
  try {
    await page.waitForSelector('.ght-control-footer .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$eval('.ght-control-footer', el => el.previousElementSibling.className), 'commitMessageContainer__test');
    await page.click('.ght-toggle');
    await page.evaluate(html => document.body.insertAdjacentHTML('afterbegin', html), header);
    await page.waitForSelector('[data-component="PH_Actions"] .ght-toggle');
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 1);
    assert.equal(await page.$eval('.ght-toggle', el => el.getAttribute('aria-pressed')), 'true');
    assert.equal(await page.$$eval('#commit-card .ght-toggle', els => els.length), 0);
  } finally { await page.close(); }
});
