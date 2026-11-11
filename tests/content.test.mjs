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
    await page.evaluate(() => { history.pushState({}, '', '/owner/repo/actions'); window.dispatchEvent(new PopStateEvent('popstate')); });
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
    for (const key of ['settingsGroupPages', 'partIssues', 'partLists', 'partReleases', 'partDiscussions', 'partWiki', 'partFeed']) assert.ok(table[key]?.message, `${locale}: missing ${key}`);
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

const issuePage = `<main><div data-component="PageHeader"><div data-component="TitleArea"><h1><bdi class="markdown-title" data-testid="issue-title">Hello issue title</bdi><span class="d-inline-flex"><span class="issueNumberText__test"> #42</span></span></h1></div><div data-component="PH_Actions"><button>Edit</button></div></div><h2><bdi data-testid="issue-title-sticky">Hello issue title</bdi></h2><article data-testid="issue-body"><div id="issue-body-viewer"><div class="markdown-body" data-testid="markdown-body"><div class="markdown-body"><p>Hello issue description <code>runner.import()</code></p><pre>source code stays Hello</pre></div></div></div><div class="IssueBodyTaskList__test"><div role="toolbar" aria-label="Reactions"><button>Add artifact</button><button class="smile" aria-label="Add reaction">Smile</button></div></div></article><article data-testid="comment-viewer-outer-box" id="issue-comment"><div class="markdown-body">Hello issue comment</div><div role="toolbar" aria-label="Reactions"><button class="smile">Smile</button></div></article><form><textarea>Hello draft</textarea><div class="markdown-body">Hello draft preview</div></form></main>`;

const referencedCommitStyles = '<style>[class*="referencedCommitContainer"]{display:flex;flex-direction:column;gap:2px;margin-bottom:20px}[class*="commitHeaderRow"]{display:flex;align-items:center;row-gap:4px}[class*="commitMetadata"]{display:flex;align-items:center;min-width:0}[class*="commitMessageText"]{display:flex;overflow:hidden;white-space:nowrap;max-width:500px}[class*="commitActions"]{display:flex;flex:1;justify-content:flex-end;column-gap:8px;margin-left:4px}.markdown-body p{font:12px/18px monospace;margin:0}.verified{height:20px;white-space:nowrap}.sha{font:12px/18px monospace;white-space:nowrap}</style>';
const referencedActions = '<div class="commitActions__test"><button class="verified">Verified</button><a class="sha" href="/owner/repo/commit/bb08107">bb08107</a></div>';
const referencedBody = '<div class="markdown-body"><p style="white-space:pre-wrap">Hello expanded commit <a class="issue-link" href="/owner/repo/issues/42">#42</a>\n\nCo-Authored-By: Hello Author &lt;author@example.com&gt;</p></div>';
const referencedCommit = (id, body = '') => `<div class="referencedCommitContainer__test" id="${id}"><div class="commitHeaderRow__test"><div class="commitMetadata__test"><div class="commitMessageText__test"><a class="commitHashLink__test" href="/owner/repo/commit/bb08107"><div class="markdown-body"><p>docs(compiler-test-utils): Hello linked commit <code>runner.import()</code></p></div></a></div><button class="expand" aria-label="Show commit message body">…</button></div>${referencedActions}</div>${body}</div>`;

test('referenced Issue commits place one compact control before Verified, outside the message link, and share it with a late body', async () => {
  const { page, settled } = await fixture(referencedCommitStyles + referencedCommit('reference-one') + referencedCommit('reference-two'), { path: '/owner/repo/issues/42' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('[data-ght-clone]').length === 2);
    await settled();
    assert.equal(await page.$$eval('[class*="commitActions"] .ght-toggle', els => els.length), 2);
    assert.equal(await page.$$eval('a .ght-toggle, p .ght-toggle', els => els.length), 0);
    assert.equal(await page.$eval('#reference-one .ght-control-slot', el => el.nextElementSibling.className), 'verified');
    assert.match(await page.$eval('#reference-one [data-ght-clone]', el => el.textContent), /^docs\(compiler-test-utils\): Привет/);
    assert.equal(await page.$eval('#reference-one code', el => el.textContent), 'runner.import()');
    for (const width of [1280, 375]) {
      await page.setViewport({ width, height: 900 });
      const alignment = await page.$eval('#reference-one [class*="commitActions"]', el => {
        const button = el.querySelector('.ght-toggle').getBoundingClientRect();
        const verified = el.querySelector('.verified').getBoundingClientRect();
        return { offset: Math.abs(button.top + button.height / 2 - verified.top - verified.height / 2), width: button.width, right: el.getBoundingClientRect().right, compact: getComputedStyle(el.querySelector('.ght-toggle-text')).display === 'none' };
      });
      assert.ok(alignment.offset < 1, `${width}: referenced commit controls share a center line`);
      assert.equal(alignment.width, 28);
      assert.equal(alignment.compact, true);
      assert.ok(alignment.right <= width, `${width}: actions remain within the viewport`);
    }
    await page.click('#reference-one .ght-toggle');
    await page.evaluate(html => document.querySelector('#reference-one').insertAdjacentHTML('beforeend', html), referencedBody);
    await page.waitForFunction(() => document.querySelectorAll('#reference-one [data-ght-clone]').length === 2);
    await settled();
    assert.equal(await page.$$eval('#reference-one .ght-toggle', els => els.length), 1);
    assert.equal(await page.$$eval('#reference-one [data-ght-clone]', els => els.every(el => el.hasAttribute('data-ght-hidden'))), true);
    assert.equal(await page.$eval('#reference-two [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), false);
    assert.match(await page.$eval('#reference-one > .markdown-body [data-ght-clone]', el => el.textContent), /Co-Authored-By: Hello Author <author@example.com>/);
    assert.equal(await page.$eval('#reference-one > .markdown-body [data-ght-clone] a', el => el.getAttribute('href')), '/owner/repo/issues/42');
    await page.evaluate(() => document.querySelector('#reference-one [class*="commitActions"]').remove());
    await page.waitForSelector('#reference-one [class*="commitHeaderRow"] > .ght-control-slot .ght-toggle[aria-pressed="true"]');
    await page.evaluate(html => document.querySelector('#reference-one [class*="commitHeaderRow"]').insertAdjacentHTML('beforeend', html), referencedActions);
    await page.waitForSelector('#reference-one [class*="commitActions"] .ght-toggle[aria-pressed="true"]');
    assert.equal(await page.$$eval('#reference-one .ght-toggle', els => els.length), 1);
    await page.click('.ght-fab');
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('referenced Issue commits respect the commit title and body settings independently of Issue text', async () => {
  const { page, settled } = await fixture(issuePage + referencedCommit('reference-settings', referencedBody), { path: '/owner/repo/issues/42', parts: { issues: false } });
  try {
    await page.waitForSelector('#reference-settings [data-ght-clone]');
    await settled();
    assert.equal(await page.$$eval('h1 [data-ght-clone], [data-testid="issue-body"] [data-ght-clone]', els => els.length), 0);
    await page.evaluate(() => {
      window.__settings.parts = { issues: true, commitTitles: false, commitBodies: false };
      for (const listener of window.__storageListeners) listener({ settings: {} }, 'local');
    });
    await page.waitForSelector('[data-testid="issue-body"] [data-ght-clone]');
    await settled();
    assert.equal(await page.$$eval('#reference-settings [data-ght-clone], #reference-settings .ght-toggle', els => els.length), 0);
  } finally { await page.close(); }
});

test('Issues translate both headings, the innermost rendered body and comments while preserving code and drafts', async () => {
  const { page, settled } = await fixture(issuePage, { path: '/owner/repo/issues/42' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 3);
    await settled();
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length), 4);
    assert.equal(await page.$eval('pre', el => el.textContent), 'source code stays Hello');
    assert.equal(await page.$eval('code', el => el.textContent), 'runner.import()');
    assert.equal(await page.$$eval('form [data-ght-clone], form .ght-toggle', els => els.length), 0);
    assert.equal(await page.$$eval('[data-component="PH_Actions"] .ght-toggle', els => els.length), 0);
    assert.equal(await page.$eval('h1 .ght-toggle', el => el.closest('[class*="issueNumberText"]').firstChild.textContent.trim()), '#42');
    assert.equal(await page.$eval('[data-testid="issue-body"] .ght-control-slot', el => el.parentElement.getAttribute('aria-label')), 'Reactions');
    assert.equal(await page.$eval('[data-testid="issue-body"] .ght-control-slot', el => el.previousElementSibling.className), 'smile');
    await page.click('#issue-comment .ght-toggle');
    assert.equal(await page.$eval('#issue-comment [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), true);
    assert.equal(await page.$eval('[data-testid="issue-body"] [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), false);
    await page.click('h1 .ght-toggle');
    assert.equal(await page.$$eval('[data-testid="issue-title"], [data-testid="issue-title-sticky"]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    await page.click('.ght-fab');
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('Issue and Discussion title controls follow the number at wide and narrow widths and survive its replacement', async () => {
  const longTitle = 'Hello module runner imports during a full reload with old and new module instances '.repeat(2);
  for (const kind of ['issue', 'discussion']) {
    const text = kind === 'issue' ? `<bdi data-testid="issue-title">${longTitle}</bdi>` : `<span class="js-issue-title">${longTitle}</span>`;
    const numberClass = kind === 'issue' ? 'issueNumberText__test' : 'gh-header-number';
    const { page, settled } = await fixture(`<style>h1{font-size:32px;line-height:36px;font-weight:400;margin:0}main{max-width:100%}</style><main><div data-component="PageHeader" class="gh-header"><h1 class="gh-header-title">${text}<span class="${numberClass}"> #24046</span></h1><div data-component="PH_Actions" class="gh-header-actions"><button>Edit</button></div></div></main>`, { path: `/owner/repo/${kind === 'issue' ? 'issues' : 'discussions'}/24046` });
    try {
      await page.waitForSelector('h1 .ght-toggle[data-state="done"]');
      await settled();
      for (const width of [1280, 375]) {
        await page.setViewport({ width, height: 900 });
        const layout = await page.$eval('h1', heading => {
          const control = heading.querySelector('.ght-toggle').getBoundingClientRect();
          const number = heading.querySelector('[class*="issueNumberText"], .gh-header-number');
          const range = document.createRange();
          range.selectNodeContents(number.firstChild);
          const text = range.getBoundingClientRect();
          return { gap: control.left - text.right, offset: Math.abs(control.top + control.height / 2 - text.top - text.height / 2), right: control.right, edge: heading.getBoundingClientRect().right, top: control.top, headingTop: heading.getBoundingClientRect().top };
        });
        assert.ok(layout.gap >= 6 && layout.gap <= 10, `${kind} ${width}: button follows number`);
        assert.ok(layout.offset <= 8, `${kind} ${width}: button stays on the number's line`);
        assert.ok(layout.right <= layout.edge + 1, `${kind} ${width}: no overflow`);
        assert.ok(layout.top > layout.headingTop + 30, `${kind} ${width}: button follows the wrapped title`);
      }
      assert.equal(await page.$$eval('[data-component="PH_Actions"] .ght-toggle', els => els.length), 0);
      await page.click('h1 .ght-toggle');
      await page.evaluate(numberClass => {
        document.querySelector(`.${numberClass}`).outerHTML = `<span class="${numberClass}"> #24046</span>`;
      }, numberClass);
      await page.waitForSelector(`.${numberClass} .ght-toggle[aria-pressed="true"]`);
      assert.equal(await page.$$eval('.ght-toggle', els => els.length), 1);
    } finally { await page.close(); }
  }
});

test('modern Issue reaction rows keep the control after the smile button when GitHub replaces the toolbar', async () => {
  const { page, settled } = await fixture(issuePage, { path: '/owner/repo/issues/42' });
  try {
    await page.waitForSelector('[data-testid="issue-body"] [role="toolbar"] .ght-toggle[data-state="done"]');
    await settled();
    await page.click('[data-testid="issue-body"] .ght-toggle');
    await page.evaluate(() => {
      document.querySelector('[data-testid="issue-body"] [role="toolbar"]').outerHTML = '<div role="toolbar" aria-label="Reactions"><button>Add artifact</button><button class="smile">Smile</button></div>';
    });
    await page.waitForSelector('[data-testid="issue-body"] [role="toolbar"] .ght-toggle[aria-pressed="true"]');
    assert.equal(await page.$$eval('[data-testid="issue-body"] .ght-toggle', els => els.length), 1);
    assert.equal(await page.$eval('[data-testid="issue-body"] .ght-control-slot', el => el.previousElementSibling.className), 'smile');
    await page.setViewport({ width: 375, height: 900 });
    assert.equal(await page.$eval('[data-testid="issue-body"] [role="toolbar"]', el => {
      const row = el.getBoundingClientRect();
      const button = el.querySelector('.ght-toggle').getBoundingClientRect();
      return getComputedStyle(el).display === 'flex' && button.left >= row.left && button.right <= row.right;
    }), true);
  } finally { await page.close(); }
});

const workList = `<main><div data-testid="issues-list-surface"><div role="toolbar"><button>Sort</button><span>2 Open</span></div><ul data-listview-component="items-list"><li><h3><a data-testid="issue-listitem-title-link" href="/owner/repo/issues/42">Hello issue <code>SomeApi()</code></a></h3><span class="label">bug</span></li><li><h3><a data-testid="listitem-title-link" data-hovercard-type="pull_request" href="/owner/repo/pull/43">fix(ui): Hello pull request</a></h3><span class="label">enhancement</span></li></ul></div></main>`;

test('PR and issue lists use only the page button, preserve labels and links, and inherit selection for lazy rows', async () => {
  for (const path of ['/owner/repo/issues', '/owner/repo/pulls', '/issues', '/pulls']) {
    const { page, settled } = await fixture(workList, { path });
    try {
      await page.waitForFunction(() => document.querySelectorAll('ul [data-ght-clone]').length === 2);
      await settled();
      assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
      assert.equal(await page.$eval('ul [data-ght-clone]', el => el.getAttribute('href')), '/owner/repo/issues/42');
      assert.deepEqual(await page.$$eval('.label', els => els.map(el => el.textContent)), ['bug', 'enhancement']);
      await page.click('.ght-fab');
      await page.evaluate(() => document.querySelector('ul').insertAdjacentHTML('beforeend', '<li><a data-testid="issue-listitem-title-link" href="/owner/repo/issues/44">Hello late issue</a></li>'));
      await page.waitForFunction(() => document.querySelectorAll('ul [data-ght-clone]').length === 3);
      assert.equal(await page.$$eval('ul [data-ght-clone]', els => els.every(el => el.hasAttribute('data-ght-hidden'))), true);
      await page.click('.ght-fab');
      assert.equal(await page.$$eval('ul [data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
      assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
    } finally { await page.close(); }
  }
});

test('classic issue list titles can translate inside bulk-action forms without touching their controls', async () => {
  const { page, settled } = await fixture('<main><form><div class="Box"><div class="Box-header">Open <button>Label</button></div><div class="js-navigation-container"><div class="js-issue-row"><input type="checkbox"><a class="js-navigation-open" href="/owner/repo/issues/42">Hello classic issue</a></div></div></div><textarea>Hello editable draft</textarea></form></main>', { path: '/owner/repo/issues' });
  try {
    await page.waitForSelector('[data-ght-clone]');
    await settled();
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length), 1);
    assert.equal(await page.$eval('textarea', el => el.value), 'Hello editable draft');
    assert.equal(await page.$eval('input', el => el.type), 'checkbox');
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
  } finally { await page.close(); }
});

test('page-only controls can retry a failed translation without adding local buttons', async () => {
  const { page, settled } = await fixture(workList, { path: '/owner/repo/issues', mode: 'error' });
  try {
    await page.waitForFunction(() => document.querySelector('.ght-fab').textContent.includes('Retry'));
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
    assert.match(await page.$eval('.ght-fab', el => el.title), /Translation failed/);
    await page.evaluate(() => { window.__engineMode = 'ready'; });
    await page.click('.ght-fab');
    await page.waitForFunction(() => document.querySelectorAll('[data-ght-clone]').length === 2);
    await settled();
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => el.hasAttribute('data-ght-hidden'))), true);
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
  } finally { await page.close(); }
});

const releaseStyles = '<style>.d-flex{display:flex!important}.flex-1{flex:1}.flex-column{flex-direction:column}.tmp-mb-3{margin-bottom:16px}.f1{font-size:32px;line-height:48px}.compare-action{height:28px}section{margin-bottom:24px}@media(min-width:768px){.flex-md-row{flex-direction:row}}</style>';
const releaseCard = id => `<section data-release-anchor="${id}" id="${id}"><div class="Box"><div class="Box-body"><div class="d-flex flex-md-row flex-column"><div class="d-flex flex-1 tmp-mb-3"><div class="flex-1"><span class="f1"><a href="/owner/repo/releases/tag/${id}">Hello release ${id}</a></span></div></div><div class="d-flex tmp-mb-3 release-actions"><select-panel><dialog-helper><button class="compare-action" aria-haspopup="dialog">Compare</button><dialog><h1>Choose a tag</h1></dialog></dialog-helper></select-panel></div></div><div class="markdown-body" data-test-selector="body-content"><p>Hello release notes <code>v1.2.3</code></p><pre>Hello command</pre><a class="issue-link" href="/owner/repo/issues/42">#42</a></div><div class="release-assets"><a href="/owner/repo/releases/download/${id}/package.zip">package.zip</a></div></div></div></section>`;

test('release cards group their title and notes, preserving versions, assets, references and code', async () => {
  const { page, settled } = await fixture(releaseStyles + releaseCard('v1.2.3') + releaseCard('v1.2.4'), { path: '/owner/repo/releases' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 2);
    await settled();
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length), 4);
    await page.click('#v1\\.2\\.3 .ght-toggle');
    assert.equal(await page.$$eval('#v1\\.2\\.3 [data-ght-clone]', els => els.every(el => el.hasAttribute('data-ght-hidden'))), true);
    assert.equal(await page.$$eval('#v1\\.2\\.4 [data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    assert.equal(await page.$eval('.release-assets a', el => el.textContent), 'package.zip');
    assert.equal(await page.$eval('pre', el => el.textContent), 'Hello command');
    assert.equal(await page.$eval('.issue-link', el => el.getAttribute('href')), '/owner/repo/issues/42');
    for (const width of [1280, 375]) {
      await page.setViewport({ width, height: 900 });
      const alignment = await page.$eval('.release-actions', el => {
        const button = el.querySelector('.ght-toggle').getBoundingClientRect();
        const compare = el.querySelector('.compare-action').getBoundingClientRect();
        return { offset: Math.abs(button.top - compare.top), height: button.height, nativeHeight: compare.height, before: el.firstElementChild.classList.contains('ght-control-slot'), insideMenu: Boolean(el.querySelector('select-panel .ght-toggle')), right: compare.right };
      });
      assert.ok(alignment.offset < 1, `${width}: release actions align at the top`);
      assert.equal(alignment.height, alignment.nativeHeight);
      assert.equal(alignment.before, true);
      assert.equal(alignment.insideMenu, false);
      assert.ok(alignment.right <= width);
    }
    await page.evaluate(() => {
      const actions = document.querySelector('.release-actions');
      actions.outerHTML = '<div class="d-flex tmp-mb-3 release-actions"><select-panel><dialog-helper><button class="compare-action" aria-haspopup="dialog">Compare</button></dialog-helper></select-panel></div>';
    });
    await page.waitForSelector('.release-actions .ght-toggle[aria-pressed="true"]');
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 2);
  } finally { await page.close(); }
});

test('single release pages also group a native h1 title with their notes', async () => {
  const picker = '<include-fragment><div class="Overlay" role="dialog"><h1>Hello tag picker</h1><div class="markdown-body">Hello menu text</div><input placeholder="Hello tag"></div></include-fragment>';
  const body = releaseCard('v1.2.3').replace('<span class="f1"><a href="/owner/repo/releases/tag/v1.2.3">Hello release v1.2.3</a></span>', `<h1>Hello release v1.2.3</h1>${picker}`).replace('<section data-release-anchor="v1.2.3" id="v1.2.3">', '<section>');
  const { page, settled } = await fixture(releaseStyles + body, { path: '/owner/repo/releases/tag/v1.2.3' });
  try {
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 1);
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length), 2);
    assert.equal(await page.$$eval('[role="dialog"] [data-ght-source], [role="dialog"] [data-ght-clone]', els => els.length), 0);
  } finally { await page.close(); }
});

const discussionComment = (id, text) => `<div class="discussion-comment" id="${id}"><table><tbody><tr><td class="markdown-body">${text}</td></tr></tbody></table><div class="comment-reactions"><button>Smile</button></div></div>`;

test('discussion bodies, accepted answers and nested replies keep independent local controls', async () => {
  const { page, settled } = await fixture(`<main><div class="gh-header"><h1 class="gh-header-title"><span class="js-issue-title markdown-title">Hello discussion</span> <span class="gh-header-number">#42</span></h1><div class="gh-header-actions"></div></div>${discussionComment('discussion-body', 'Hello question')}${discussionComment('accepted-answer', 'Hello accepted answer')}${discussionComment('nested-reply', 'Hello reply')}</main>`, { path: '/owner/repo/discussions/42' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 4);
    await settled();
    await page.click('#accepted-answer .ght-toggle');
    assert.equal(await page.$eval('#accepted-answer [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), true);
    assert.equal(await page.$eval('#nested-reply [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), false);
    assert.equal(await page.$eval('.gh-header-number .ght-toggle', el => el.getAttribute('aria-label').startsWith('Discussions:')), true);
    assert.equal(await page.$$eval('.gh-header-actions .ght-toggle', els => els.length), 0);
    await page.click('.ght-fab');
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('pinned discussions and the ordinary discussion list use only the page button', async () => {
  const { page, settled } = await fixture('<main class="repository-content"><h3><a class="discussion-title" href="/owner/repo/discussions/1">Hello pinned discussion</a></h3><div class="Box"><div class="Box-header">Discussions</div><div class="js-navigation-container"><h3><a class="discussion-Link--secondary" href="/owner/repo/discussions/2">Hello second discussion</a></h3></div></div></main>', { path: '/owner/repo/discussions' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('[data-ght-clone]').length === 2);
    await settled();
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length === 2 && els.every(el => el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('Compare translates commit messages while leaving inline commands, PR references and the diff untouched', async () => {
  const nativeActions = '<div class="d-flex flex-shrink-0 metadata"><button class="signed-commit-badge">Verified</button><div class="ButtonGroup"><button class="commit-sha">1234567</button></div></div>';
  const { page, settled } = await fixture(`<style>.d-flex{display:flex!important}.flex-auto{flex:1;min-width:0}.flex-shrink-0{flex-shrink:0}.metadata button{height:32px}li{padding:8px}p{margin:0 0 4px}pre{white-space:pre-wrap}</style><main><ul><li class="d-flex js-commits-list-item"><div class="flex-auto js-details-container"><p><a class="markdown-title" href="/owner/repo/commit/1234567">fix: Hello before </a><code><a class="markdown-title" href="/owner/repo/commit/1234567">yarn config get</a></code><a class="issue-link" href="/owner/repo/pull/42">#42</a><button class="ellipsis-expander">…</button></p><div class="Details-content--hidden"><pre>Hello commit description</pre></div></div>${nativeActions}</li></ul><div class="js-file-content markdown-body">Hello source diff</div><form><div class="markdown-body">Hello comparison draft</div></form></main>`, { path: '/owner/repo/compare/v1...v2' });
  try {
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 1);
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length), 2);
    assert.equal(await page.$eval('code', el => el.textContent), 'yarn config get');
    assert.equal(await page.$eval('.js-file-content', el => el.textContent), 'Hello source diff');
    assert.equal(await page.$eval('.issue-link', el => el.textContent), '#42');
    assert.equal(await page.$eval('.metadata .ght-control-slot', el => el.nextElementSibling.className), 'signed-commit-badge');
    for (const width of [1280, 375]) {
      await page.setViewport({ width, height: 900 });
      const alignment = await page.$eval('.metadata', el => {
        const control = el.querySelector('.ght-toggle').getBoundingClientRect();
        const native = el.querySelector('.signed-commit-badge').getBoundingClientRect();
        return { offset: Math.abs(control.top - native.top), height: control.height, nativeHeight: native.height, gap: native.left - control.right, right: el.getBoundingClientRect().right };
      });
      assert.ok(alignment.offset < 1, `${width}: Compare actions align at the top`);
      assert.equal(alignment.height, alignment.nativeHeight);
      assert.equal(alignment.gap, 8);
      assert.ok(alignment.right <= width);
    }
    await page.click('.ght-toggle');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => el.hasAttribute('data-ght-hidden'))), true);
    await page.evaluate(html => { document.querySelector('.metadata').outerHTML = html; }, nativeActions);
    await page.waitForSelector('.metadata .ght-toggle[aria-pressed="true"]');
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 1);
  } finally { await page.close(); }
});

test('Wiki title, document and footer use only the page button; in-page links keep their original anchors', async () => {
  const { page, settled } = await fixture('<main id="wiki-wrapper"><div class="gh-header"><h1 class="gh-header-title">Hello wiki page</h1><div class="gh-header-actions"><a href="#pages">Pages</a></div></div><div id="wiki-body"><div class="markdown-body"><h2 id="section">Hello section</h2><a href="#section">Hello section link</a><pre>Hello code</pre></div></div><div id="wiki-footer"><div class="markdown-body">Hello footer</div></div></main>', { path: '/owner/repo/wiki/Getting-Started' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('[data-ght-clone]').length === 3);
    await settled();
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length), 3);
    assert.equal(await page.$$eval('#section', els => els.length), 1);
    assert.equal(await page.$eval('#section', el => Boolean(el.closest('[data-ght-clone]'))), true);
    await page.click('.ght-fab');
    assert.equal(await page.$eval('#section', el => Boolean(el.closest('[data-ght-clone]'))), false);
    assert.equal(await page.$eval('a[href="#section"]', el => el.getAttribute('href')), '#section');
    assert.equal(await page.$eval('pre', el => el.textContent), 'Hello code');
  } finally { await page.close(); }
});

const feedCard = id => `<article data-testid="feed-card" id="${id}"><h3><a data-hovercard-type="user" href="/alice">alice</a> Hello <a data-hovercard-type="repository" href="/owner/repo">owner/repo</a> <a href="/owner/repo/issues/42">Hello issue</a></h3><p>Hello activity description <relative-time datetime="2026-11-01">2 weeks ago</relative-time></p><div class="markdown-body"><p>Hello release excerpt</p><pre>Hello command</pre></div><div data-testid="feed-actions"><button type="button" class="star">Star</button><span>42 stars</span></div></article>`;

test('Home and Feed translate card content with one local switch per card, preserving identities, timestamps and actions', async () => {
  for (const path of ['/', '/dashboard', '/dashboard-feed', '/feed']) {
    const { page, settled } = await fixture(`<main id="dashboard">${feedCard('first-card')}${feedCard('second-card')}<nav><a href="/owner/repo/issues/43">Hello navigation</a></nav><form><div class="markdown-body">Hello editable preview</div></form></main>`, { path });
    try {
      await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 2);
      await settled();
      assert.equal(await page.$$eval('#first-card [data-ght-clone]', els => els.length), 3);
      assert.equal(await page.$eval('#first-card [data-testid="feed-actions"]', el => el.previousElementSibling.classList.contains('ght-control-slot')), true);
      assert.equal(await page.$eval('#first-card [data-ght-clone] [data-hovercard-type="repository"]', el => el.textContent), 'owner/repo');
      assert.equal(await page.$eval('#first-card p[data-ght-clone] relative-time', el => el.textContent), '2 weeks ago');
      assert.equal(await page.$eval('#first-card .star', el => el.textContent), 'Star');
      assert.equal(await page.$$eval('form [data-ght-clone], nav [data-ght-clone]', els => els.length), 0);
      await page.click('#first-card .ght-toggle');
      assert.equal(await page.$$eval('#first-card [data-ght-clone]', els => els.every(el => el.hasAttribute('data-ght-hidden'))), true);
      assert.equal(await page.$$eval('#second-card [data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
      await page.click('.ght-fab');
      await page.click('.ght-fab');
      assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    } finally { await page.close(); }
  }
});

test('legacy feed content and newly loaded cards are translated without duplicating nested content', async () => {
  const { page, settled } = await fixture('<main id="dashboard"><div class="news"><div class="body" id="legacy"><p>Hello activity</p><div class="markdown-body"><p>Hello excerpt</p></div></div></div></main>', { path: '/dashboard-feed' });
  try {
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$$eval('#legacy [data-ght-clone]', els => els.length), 2);
    await page.evaluate(html => document.querySelector('main').insertAdjacentHTML('beforeend', html), feedCard('late-card'));
    await page.waitForSelector('#late-card .ght-toggle[data-state="done"]');
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 2);
    assert.equal(await page.$$eval('#late-card [data-ght-clone]', els => els.length), 3);
  } finally { await page.close(); }
});

test('new page settings can disable translation and navigation restores originals and removes source markers', async () => {
  const { page, settled } = await fixture(issuePage, { path: '/owner/repo/issues/42' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 3);
    await settled();
    await page.evaluate(() => {
      window.__settings.parts = { issues: false };
      for (const listener of window.__storageListeners) listener({ settings: {} }, 'local');
    });
    await page.waitForFunction(() => !document.querySelector('.ght-toggle, [data-ght-clone], [data-ght-source]'));
    await page.evaluate(() => {
      window.__settings.parts = { issues: true };
      for (const listener of window.__storageListeners) listener({ settings: {} }, 'local');
    });
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 3);
    await page.evaluate(() => { history.pushState({}, '', '/owner/repo/settings'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForFunction(() => !document.querySelector('.ght-fab, .ght-toggle, [data-ght-clone], [data-ght-source]'));
  } finally { await page.close(); }
});
