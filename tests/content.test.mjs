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
    channel: 'chrome',
    executablePath: process.env.CHROME_PATH,
    headless: true,
    args: process.env.CI ? ['--no-sandbox', '--disable-gpu'] : [],
    protocolTimeout: 30000,
    dumpio: Boolean(process.env.CI),
  });
  // Fail the shared setup once if Chrome cannot initialize CDP, rather than timing out per fixture.
  const page = await browser.newPage();
  await page.close();
});
after(async () => browser?.close());

async function fixture(body, { path = '/owner/repo/pull/1', mode = 'ready', auto = true, detector = 'en', cld = 'en', target = 'ru', parts } = {}) {
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
  await page.evaluate(({ messages, mode, auto, detector, cld, target, parts }) => {
    window.__engineMode = mode;
    window.__settings = { target, auto, ...(parts && { parts }) };
    window.__storageListeners = [];
    window.__requests = [];
    window.__translationSources = [];
    window.__preparedSources = [];
    window.__cldCalls = 0;
    chrome.runtime = { onMessage: { addListener: listener => { window.__onMessage = listener; } } };
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
        else if (detector === 'mixed') {
          const lang = /\p{Script=Han}/u.test(args.text) ? 'zh' : /\p{Script=Cyrillic}/u.test(args.text) ? 'ru' : 'en';
          result = [{ lang, confidence: 1 }];
        } else result = [{ lang: args.text.includes('Already Russian') ? 'ru' : detector, confidence: 1 }];
      }
      else if (op === 'translator.prepare') {
        window.__preparedSources.push(args.source);
        if (window.__engineMode === 'waiting-download') {
          window.__finishDownload = () => {
            window.__engineMode = 'ready';
            window.dispatchEvent(new CustomEvent('ght:res', { detail: JSON.stringify({ id, result: true }) }));
          };
          return;
        }
        if (window.__engineMode === 'download-error') error = 'Download failed';
        else window.__engineMode = 'ready';
      } else if (op === 'translator.translate') {
        window.__translationSources.push(args.source);
        if (window.__engineMode === 'stalled') { window.__hungRequest = id; return; }
        if (args.source === 'be') {
          error = 'Unsupported language pair';
          code = 'NotSupportedError';
        } else if (['activation', 'download-error', 'waiting-download'].includes(window.__engineMode)
          || (window.__engineMode === 'chinese-download' && args.source === 'zh')) {
          error = 'Activation needed';
          code = 'activation';
        } else if (window.__engineMode === 'error') error = 'Translation failed';
        else if (args.source === 'zh' && detector === 'mixed') {
          result = args.texts.map(text => text.replaceAll('警告去重与缺失条件处理', 'Обработка предупреждений')
            .replaceAll('目标选择与回调测试', args.target === 'en' ? 'Callback test' : 'Проверка обратного вызова'));
        } else result = args.texts.map(text => text.replaceAll('Hello', 'Привет').replaceAll('use shared', 'использовать общие')
          .replaceAll('is a powerful', '— мощный').replaceAll('Layer / File(s)', 'Слой / Файлы'));
      }
      window.dispatchEvent(new CustomEvent('ght:res', { detail: JSON.stringify({ id, result, error, code }) }));
    });
  }, { messages, mode, auto, detector, cld, target, parts });
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
const timeline = `<div class="js-details-container" id="timeline-commit"><div class="d-flex"><div class="title"><code><a class="markdown-title" href="/owner/repo/pull/1/commits/d9a1e8c">Hello commit</a></code><button id="expand">…</button></div><div id="verified">Verified</div><div>✓</div><div class="text-right"><code><a href="/owner/repo/pull/1/commits/d9a1e8c">d9a1e8c</a></code></div></div><div class="Details-content--hidden" hidden><pre>Hello commit body</pre></div></div>`;
const row = id => `<li data-testid="commit-row-item" id="${id}"><div data-listview-item-title-container><h4><a href="#${id}"><span>Hello ${id}</span></a></h4></div><div><div class="extended-commit-description-container">Hello body</div></div><div class="metadata"><span class="verified">Verified</span><div class="primary d-none d-sm-flex"><a data-testid="commit-row-browse-repo" href="#browse">Browse</a></div></div></li>`;

test('comment controls sit after reactions; global actions reset local choices and synchronize both PR headings', async () => {
  const { page, settled } = await fixture(title + '<h2 class="PageHeader-Title"><a><span class="markdown-title">Hello title</span></a></h2>' + comment());
  try {
    await page.waitForSelector('#pullrequest-1 .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$eval('.ght-fab', el => el.textContent), 'Show all originals');
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

test('the borderless PR timeline toggle follows the nested commit hash and keeps its choice', async () => {
  const { page, settled } = await fixture('<style>#timeline-commit .d-flex{display:flex;align-items:center}.title{flex:1}</style>' + timeline);
  try {
    await page.waitForSelector('#timeline-commit .ght-toggle[data-state="done"]');
    await settled();
    assert.deepEqual(await page.$eval('#timeline-commit .ght-control-slot', el => {
      const hash = el.previousElementSibling.querySelector('a');
      const link = hash.getBoundingClientRect();
      const toggle = el.getBoundingClientRect();
      return {
        hash: hash.textContent,
        gap: toggle.left - link.right,
        border: getComputedStyle(el.querySelector('.ght-toggle')).borderWidth,
        rightmost: toggle.right === el.closest('.d-flex').getBoundingClientRect().right,
        aligned: Math.abs(toggle.top + toggle.height / 2 - link.top - link.height / 2) < 1,
      };
    }), { hash: 'd9a1e8c', gap: 4, border: '0px', rightmost: true, aligned: true });
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

test('borderless commit list toggles sit after metadata and affect only their own row', async () => {
  const { page, settled } = await fixture(`<style>.metadata{display:flex;justify-content:flex-end;gap:8px}</style><ul>${row('first')}${row('second')}</ul>`, { path: '/owner/repo/pull/1/commits' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 2);
    await settled();
    assert.deepEqual(await page.$eval('#first .metadata', el => {
      const control = el.lastElementChild.querySelector('.ght-toggle');
      return [getComputedStyle(control).borderWidth, control.getBoundingClientRect().right === el.getBoundingClientRect().right];
    }), ['0px', true]);
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
  const header = '<div class="header"><nav><span class="octicon-book"></span>README</nav><div class="readmeHeaderSlot"></div><button id="readme-edit" aria-label="Edit file">✎</button><button id="readme-outline" aria-label="Outline">☰</button></div>';
  const layout = '<style>.header{display:flex;align-items:center}.header nav{flex:1}#readme-edit{width:28px;margin-inline-end:8px}#readme-outline{width:34px}</style>';
  const { page, settled } = await fixture(`${layout}<div id="repository-readme">${header}<div><article itemprop="text" class="markdown-body"><h1 id="hello">Hello README</h1></article></div></div>`, { path: '/owner/repo' });
  try {
    await page.waitForSelector('.header .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$eval('.readmeHeaderSlot', el => el.previousElementSibling.classList.contains('ght-control-icon')), true);
    assert.deepEqual(await page.$eval('.header', el => {
      const center = selector => {
        const rect = el.querySelector(selector).getBoundingClientRect();
        return rect.left + rect.width / 2;
      };
      return [center('#readme-edit') - center('.ght-toggle'), center('#readme-outline') - center('#readme-edit')];
    }), [39, 39]);
    assert.equal(await page.$$eval('#hello', els => els.length), 1);
    assert.equal(await page.$eval('#hello', el => Boolean(el.closest('[data-ght-clone]'))), true);
    await page.click('.header .ght-toggle');
    assert.equal(await page.$eval('#hello', el => Boolean(el.closest('[data-ght-clone]'))), false);
    await page.evaluate(html => { document.querySelector('.header').outerHTML = html; }, header);
    await page.waitForSelector('.header .ght-toggle[data-state="done"]');
    assert.equal(await page.$eval('.header .ght-toggle', el => el.getAttribute('aria-pressed')), 'true');
  } finally { await page.close(); }
});

test('file preview places the translation button first in the file actions and matches Raw', async () => {
  const { page, settled } = await fixture(`
    <style>[data-component="ButtonGroup"],.file-actions{display:inline-flex;gap:4px}
    #raw-actions a,#raw-actions button.native{display:block;height:28px;box-sizing:border-box;border:1px solid #d1d9e0;background:#f6f8fa}
    #raw-actions > div:first-child a{border-start-start-radius:6px;border-end-start-radius:6px}</style>
    <div class="blobContainer"><header>
      <button id="preview" aria-pressed="true"><span data-text="Preview">Preview</span></button>
      <div class="file-actions"><button>Other actions</button>
        <div class="react-blob-header-edit-and-raw-actions">
          <div data-component="ButtonGroup" id="raw-actions">
            <div><a data-testid="raw-button">Raw</a></div><div><button class="native">Copy</button></div>
          </div>
        </div>
      </div></header>
      <section id="preview-content"><article itemprop="text" class="markdown-body">Hello document</article></section>
      <pre class="js-file-content" id="source" hidden>Hello source code</pre>
    </div>`, { path: '/owner/repo/blob/main/AGENTS.md' });
  try {
    await page.waitForSelector('.file-actions .ght-toggle[data-state="done"]');
    await settled();
    assert.deepEqual(await page.$eval('.file-actions', group => {
      const translate = group.firstElementChild.querySelector('.ght-toggle');
      const raw = group.querySelector('[data-testid="raw-button"]');
      const style = getComputedStyle(translate);
      return [
        translate.offsetHeight === raw.offsetHeight,
        style.backgroundColor === getComputedStyle(raw).backgroundColor,
        style.borderStartStartRadius, style.borderStartEndRadius,
      ];
    }), [true, true, '6px', '6px']);
    await page.click('.file-actions .ght-toggle');
    await page.evaluate(() => { document.querySelector('#preview').setAttribute('aria-pressed', 'false'); document.querySelector('#preview-content').hidden = true; document.querySelector('#source').hidden = false; });
    await page.waitForFunction(() => document.querySelector('.ght-control-slot').hidden);
    assert.equal(await page.$eval('#source', el => el.textContent), 'Hello source code');
    assert.equal(await page.$eval('[data-testid="raw-button"]', el => getComputedStyle(el).borderStartStartRadius), '6px');
    await page.evaluate(() => { document.querySelector('#preview').setAttribute('aria-pressed', 'true'); document.querySelector('#preview-content').hidden = false; document.querySelector('#source').hidden = true; });
    await page.waitForFunction(() => !document.querySelector('.ght-control-slot').hidden);
    assert.equal(await page.$eval('.file-actions .ght-toggle', el => el.getAttribute('aria-pressed')), 'true');
  } finally { await page.close(); }
});

test('a file translates the latest commit even with document translation disabled', async () => {
  const header = `<style>
    .file-row{display:flex;align-items:center;justify-content:flex-end;padding-inline:8px}
    .history{display:flex;align-items:center;gap:8px}
    .file-actions{display:flex;justify-content:flex-end}
    .file-actions button{width:28px}
    #outline{margin-inline-end:8px}
    @media(min-width:601px){#more-actions{display:none}}
    @media(max-width:600px){#outline{display:none}}
  </style><div class="file-row"><div data-testid="latest-commit"><a href="/alice">alice</a>
    <span data-testid="latest-commit-html"><a data-hovercard-type="commit" href="/owner/repo/commit/1234567">docs: Hello file</a> (<a data-hovercard-type="pull_request" href="/owner/repo/pull/42">#42</a>)</span>
    <button aria-label="Checks passed">✓</button></div>
    <div data-testid="latest-commit-details"><a href="/owner/repo/commit/1234567">1234567</a><relative-time>2 days ago</relative-time></div>
    <div class="history"><a href="/owner/repo/commits/main/test.js">History</a><div hidden><a href="/owner/repo/commits/main/test.js">History</a></div></div>
  </div>`;
  const toolbar = `<div class="file-row"><div class="file-actions">
    <div class="react-blob-header-edit-and-raw-actions"></div>
    <button id="outline"><svg class="octicon-list-unordered"></svg></button><button id="more-actions">…</button>
  </div></div>`;
  const { page, settled } = await fixture(header + toolbar + '<pre class="js-file-content">Hello source</pre>', {
    path: '/owner/repo/blob/main/test.js', auto: false, parts: { readme: false },
  });
  try {
    await page.click('.ght-fab');
    const toggle = '.history .ght-toggle';
    await page.waitForSelector(toggle + '[data-state="done"]');
    await settled();
    assert.deepEqual(await page.$eval('.history', el => [
      el.lastElementChild.classList.contains('ght-control-icon'),
      getComputedStyle(el.querySelector('.ght-toggle')).borderWidth,
    ]), [true, '0px']);
    for (const [width, action] of [[1280, '#outline'], [390, '#more-actions'], [1280, '#outline']]) {
      await page.setViewport({ width, height: 900 });
      await page.waitForFunction((toggle, action) => {
        const center = selector => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return rect.left + rect.width / 2;
        };
        return Math.abs(center(toggle) - center(action)) < 0.5;
      }, {}, toggle, action);
    }
    assert.deepEqual(await page.$$eval('[data-ght-clone] a', links => links.map(link => [link.textContent, link.getAttribute('href')])), [
      ['docs: Привет file', '/owner/repo/commit/1234567'], ['#42', '/owner/repo/pull/42'],
    ]);
    assert.equal(await page.$eval('pre', el => el.textContent), 'Hello source');
    await page.click(toggle);
    assert.equal(await page.$eval('[data-testid="latest-commit-html"]', el => [el.textContent.trim(), el.hasAttribute('data-ght-hidden')].join('|')), 'docs: Hello file (#42)|false');
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
      for (const listener of window.__storageListeners) listener({ settings: { newValue: window.__settings } }, 'local');
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
    assert.equal(await page.$eval('.ght-fab', el => el.textContent), 'Translate');
    await page.click('.ght-fab');
    await settled();
    await page.waitForFunction(() => window.__requests.includes('detector.detect'));
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.length), 0);
  } finally { await page.close(); }
});

test('the keyboard command starts manual translation and toggles the original', async () => {
  const { page } = await fixture(comment(), { auto: false });
  try {
    const command = () => page.evaluate(() => window.__onMessage('toggle-translation'));
    await command();
    await page.waitForSelector('[data-ght-clone]', { visible: true });
    await command();
    await page.waitForSelector('[data-ght-clone]', { hidden: true });
    await command();
    await page.waitForSelector('[data-ght-clone]', { visible: true });
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

test('a PR comment matches the round reaction control and uses the same gap with or without reactions', async () => {
  const { page } = await fixture(comment());
  try {
    await page.waitForSelector('.comment-reactions .ght-toggle[data-state="done"]');
    await page.addStyleTag({ content: '.smile{box-sizing:border-box;width:26px;height:26px;border-radius:50%;border:1px solid;padding:0;font-size:0}.js-pick-reaction { display: flex } .tmp-mr-1 { margin-right: 4px }' });
    const gaps = await page.$eval('.comment-reactions', row => {
      const smile = row.querySelector('.smile');
      const translate = row.querySelector('.ght-toggle');
      const gap = (left, right) => right.getBoundingClientRect().left - left.getBoundingClientRect().right;
      const withoutReaction = gap(smile, translate);
      const form = row.querySelector('form');
      form.className = 'js-pick-reaction';
      smile.classList.add('tmp-mr-1');
      form.insertAdjacentHTML('beforeend', '<button class="tmp-mr-1" type="button">👀 1</button>');
      const eyes = form.lastElementChild;
      return [withoutReaction, gap(smile, eyes), gap(eyes, translate)];
    });
    assert.deepEqual(gaps, [4, 4, 4]);
    const shape = selector => page.$eval(selector, el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return [rect.width, rect.height, style.borderRadius, style.borderWidth];
    });
    assert.deepEqual(await shape('.ght-toggle'), await shape('.smile'));
  } finally { await page.close(); }
});

test('the PR reaction toggle sits beside the visible buttons inside the native reaction form', async () => {
  const markup = `<style>
    .js-pick-reaction, .smile-wrapper { margin-inline-end: 8px !important }
    .js-comment-reactions-options { display: flex; align-items: center }
    .smile { display: block; width: 26px; height: 26px }
  </style><div class="js-comment" id="pullrequest-1">
    <div class="markdown-body">Hello description</div>
    <div class="comment-reactions"><form class="js-pick-reaction">
      <div class="js-comment-reactions-options">
        <div class="smile-wrapper"><button type="button" class="smile">☺</button></div>
        <div class="js-reactions-container"><details hidden></details></div>
      </div>
    </form></div>
  </div>`;
  const { page } = await fixture(markup);
  try {
    const toggle = '.js-comment-reactions-options .ght-toggle';
    await page.waitForSelector(toggle + '[data-state="done"]');
    assert.equal(await page.$eval(toggle, el =>
      el.getBoundingClientRect().left - document.querySelector('.smile').getBoundingClientRect().right), 4);
    await page.click(toggle);
    assert.equal(await page.$eval(toggle, el => el.getAttribute('aria-pressed')), 'true');
  } finally { await page.close(); }
});

test('a long reaction row wraps the translation button without overflow on narrow screens', async () => {
  const { page, settled } = await fixture(comment());
  try {
    await page.setViewport({ width: 320, height: 900 });
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    await settled();
    await page.addStyleTag({ content: '.comment-reactions form{display:flex;flex-wrap:wrap;gap:6px}.comment-reactions form button{width:70px}' });
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
    assert.equal(await page.$eval('.history', el => el.lastElementChild.classList.contains('ght-control-icon')), true);
    const controlStyle = () => page.$eval('#directory-header .ght-toggle', el => ({
      border: getComputedStyle(el).borderWidth,
      background: getComputedStyle(el).backgroundColor,
      icon: getComputedStyle(el, '::before').backgroundColor,
      label: getComputedStyle(el.querySelector('.ght-toggle-text')).display,
    }));
    await page.addStyleTag({ content: ':root{color-scheme:dark;--fgColor-muted:#9198a1}' });
    assert.deepEqual(await controlStyle(), { border: '0px', background: 'rgba(0, 0, 0, 0)', icon: 'rgb(92, 180, 107)', label: 'none' });
    assert.equal(await page.$$eval('.react-directory-row .ght-toggle', els => els.length), 0);
    assert.equal(await page.$$eval('#directory [data-ght-clone]', els => els.length), 3);
    assert.match(await page.$eval('#README\\.md .react-directory-row-commit-cell [data-ght-clone]', el => el.textContent), /^feat\(scope\)!: Привет file \(#304\)$/);
    assert.match(await page.$eval('#latest-message + [data-ght-clone]', el => el.title), /Hello latest commit/);
    const preserved = await page.$$eval('#directory .react-directory-row', els => els.map(el => ({ name: el.querySelector('td a').textContent, date: el.querySelector('relative-time').textContent })));
    assert.deepEqual(preserved, [{ name: 'README.md', date: '2 weeks ago' }, { name: 'src', date: '2 weeks ago' }]);
    assert.equal(await page.$eval('[data-testid="latest-commit-details"]', el => el.textContent), '1234567last week');
    await page.click('#directory-header .ght-toggle');
    await page.mouse.move(0, 0);
    assert.equal((await controlStyle()).icon, 'rgb(145, 152, 161)');
    await page.addStyleTag({ content: ':root{color-scheme:light;--fgColor-muted:#59636e}' });
    assert.equal((await controlStyle()).icon, 'rgb(89, 99, 110)');
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
    assert.equal(await page.$eval('.ght-fab', el => el.textContent), 'Translate');
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
      for (const listener of window.__storageListeners) listener({ settings: { newValue: window.__settings } }, 'local');
    });
    await page.waitForFunction(() => !document.querySelector('#directory [data-ght-clone], #directory .ght-toggle'));
    await page.waitForSelector('#readme .ght-toggle[data-state="done"]');
    assert.equal(await page.$$eval('#directory [data-ght-hidden]', els => els.length), 0);
    assert.equal(await page.$$eval('#readme [data-ght-clone]', els => els.length), 1);
  } finally { await page.close(); }
});

const prActionHeader = `<div id="pr-header" data-component="PageHeader"><div data-component="TitleArea"><div class="titleWithAction"><h1><span class="markdown-title">docs(website): Hello Ko-fi donation card and a Sponsor button</span></h1><span class="titleSuffix">#562</span><button id="edit">Edit</button></div></div><div data-component="PH_Actions"><a id="overview" href="#overview">Try the Overview page</a><button>Merge status</button><button>Code</button></div></div><h2 class="PageHeader-Title"><a><span class="markdown-title">docs(website): Hello Ko-fi donation card and a Sponsor button</span></a></h2>`;
const prHeaderLayout = `[data-component="PageHeader"]{display:grid;grid-template-areas:"title-area actions";grid-template-columns:minmax(0,1fr) auto;gap:12px}[data-component="TitleArea"]{grid-area:title-area;min-width:0}.titleWithAction h1{display:inline;font-size:24px;font-weight:400;margin:0}.titleSuffix{font-size:24px;color:gray}[data-component="PH_Actions"]{grid-area:actions;display:flex;align-items:center;gap:8px;align-self:start;height:32px}[data-component="PH_Actions"]>a,[data-component="PH_Actions"]>button{font-size:12px;white-space:nowrap}@media(max-width:640px){[data-component="PageHeader"]{--grid-row-order-actions:1;grid-template-areas:"actions" "title-area";grid-template-columns:minmax(0,1fr)}[data-component="PH_Actions"]{flex-wrap:wrap;height:auto;justify-content:flex-end;grid-row:var(--grid-row-order-actions)}}`;

test('the PR title action sits after Overview and matches the native action buttons', async () => {
  const { page, settled } = await fixture(prActionHeader);
  try {
    await page.addStyleTag({ content: prHeaderLayout + `
      #pr-header{--button-default-bgColor-rest:#212830;--button-default-borderColor-rest:#3d444d}
      [data-component="PH_Actions"]>button{height:32px;border:1px solid #3d444d;border-radius:6px;background:#212830}
    ` });
    await page.waitForSelector('[data-component="PH_Actions"] .ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$$eval('.titleWithAction .ght-toggle', els => els.length), 0);
    assert.deepEqual(await page.$eval('#overview', el => [
      el.nextElementSibling.classList.contains('ght-control-title'),
      el.nextElementSibling.nextElementSibling.textContent,
    ]), [true, 'Merge status']);
    assert.equal(await page.$$eval('.ght-control-title', els => els.length), 1);
    const shape = selector => page.$eval(selector, el => {
      const rect = el.getBoundingClientRect();
      const { borderWidth, borderColor, borderRadius, backgroundColor } = getComputedStyle(el);
      return { height: rect.height, borderWidth, borderColor, borderRadius, backgroundColor };
    });
    assert.deepEqual(await shape('.ght-control-title .ght-toggle'), await shape('[data-component="PH_Actions"] > button'));
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
const aboutSection = `<div id="about" class="sidebarSection__test"><h2><span class="about-heading"><span>About</span><button id="edit-about" type="button">Settings</button></span></h2><p class="description__test">${aboutDescription}</p><div class="websiteRow"><a id="website" href="https://vpd-inc.gitbook.io/aspid.mvvm/">vpd-inc.gitbook.io/aspid.mvvm/</a></div><div class="topics"><a href="/topics/unity">unity</a><a href="/topics/mvvm">mvvm</a></div></div>`;

test('About translates independently with a header button, preserving names, website, topics and native settings', async () => {
  const layout = '<style>#about{width:280px}.about-heading{display:flex;align-items:center;justify-content:space-between;width:100%}</style>';
  const { page, settled } = await fixture(layout + aboutSection + readme, { path: '/owner/repo' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 2);
    await settled();
    assert.equal(await page.$eval('#edit-about', el => el.previousElementSibling.classList.contains('ght-control-icon')), true);
    assert.deepEqual(await page.$eval('.about-heading', el => {
      const heading = el.getBoundingClientRect();
      const label = el.firstElementChild.getBoundingClientRect();
      const gear = el.lastElementChild.getBoundingClientRect();
      const globe = el.querySelector('.ght-toggle').getBoundingClientRect();
      return { start: label.left - heading.left, end: heading.right - gear.right, gap: gear.left - globe.right };
    }), { start: 0, end: 0, gap: 8 });
    assert.match(await page.$eval('#about [data-ght-clone]', el => el.textContent), /^Aspid\.MVVM — мощный.*MVVM framework for Unity\.$/);
    const metadata = await page.$eval('#about', el => ({
      heading: el.querySelector('.ght-control-about').previousElementSibling.textContent,
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
      for (const listener of window.__storageListeners) listener({ settings: { newValue: window.__settings } }, 'local');
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
      for (const listener of window.__storageListeners) listener({ settings: { newValue: window.__settings } }, 'local');
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
    assert.equal(await page.$$eval('h1 .ght-toggle', els => els.length), 0);
    assert.equal(await page.$eval('h1 [class*="issueNumberText"]', el => el.textContent.trim()), '#42');
    assert.equal(await page.$eval('[data-testid="issue-body"] .ght-control-slot', el => el.parentElement.getAttribute('aria-label')), 'Reactions');
    assert.equal(await page.$eval('[data-testid="issue-body"] .ght-control-slot', el => el.previousElementSibling.className), 'smile');
    await page.click('#issue-comment .ght-toggle');
    assert.equal(await page.$eval('#issue-comment [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), true);
    assert.equal(await page.$eval('[data-testid="issue-body"] [data-ght-clone]', el => el.hasAttribute('data-ght-hidden')), false);
    await page.click('[data-component="PH_Actions"] .ght-toggle');
    assert.equal(await page.$$eval('[data-testid="issue-title"], [data-testid="issue-title-sticky"]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    await page.click('.ght-fab');
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('the neutral Issue title action matches New issue sizing in the visible actions row', async () => {
  const menu = create => `<div class="menuActionsContainer__test"><div class="create">${create}</div><button>Copy link</button></div>`;
  const context = `<div data-component="PageHeader.ContextAreaActions">${menu('<a href="/owner/repo/issues/new/choose">New issue</a>')}</div>`;
  const actions = `<div data-component="PH_Actions">${menu('<button data-component="Button" data-variant="primary">New issue</button>')}</div>`;
  const layout = `<style>:root{--button-default-bgColor-rest:#212830;--button-default-borderColor-rest:#3d444d}
    [data-component="PageHeader.ContextAreaActions"]{display:none}
    .menuActionsContainer__test{display:flex;align-items:center;gap:4px}
    .create :is(a,button){display:inline-flex;box-sizing:border-box;height:32px;border:1px solid #3e9b50;border-radius:6px;background:#238636;color:white}
    @media(max-width:767px){[data-component="PH_Actions"]{display:none}[data-component="PageHeader.ContextAreaActions"]{display:flex}}</style>`;
  const body = issuePage.replace('<div data-component="PH_Actions"><button>Edit</button></div>', context + actions);
  const { page, settled } = await fixture(layout + body, { path: '/owner/repo/issues/42' });
  try {
    for (const [width, component] of [[1280, 'PH_Actions'], [375, 'PageHeader.ContextAreaActions'], [1280, 'PH_Actions']]) {
      await page.setViewport({ width, height: 900 });
      const selector = `[data-component="${component}"] .ght-toggle`;
      await page.waitForSelector(selector + '[data-state="done"]', { visible: true });
      await settled();
      assert.deepEqual(await page.$eval(selector, el => {
        const sibling = el.parentElement.nextElementSibling;
        const shape = node => {
          const style = getComputedStyle(node);
          return [node.offsetHeight, style.borderRadius];
        };
        return [
          sibling.className,
          JSON.stringify(shape(el)) === JSON.stringify(shape(sibling.firstElementChild)),
          getComputedStyle(el).backgroundColor,
          getComputedStyle(sibling.firstElementChild).backgroundColor,
        ];
      }), ['create', true, 'rgb(33, 40, 48)', 'rgb(35, 134, 54)']);
      assert.equal(await page.$$eval('.ght-control-title', els => els.length), 1);
      if (width === 375) await page.click(selector);
    }
    assert.equal(await page.$eval('.ght-control-title .ght-toggle', el => el.getAttribute('aria-pressed')), 'true');
  } finally { await page.close(); }
});

test('the Discussion title control sits beside Edit and survives an action row replacement', async () => {
  const layout = '<style>.gh-header-actions{display:flex;align-items:center;justify-content:flex-end}.edit-action,.js-details-target{margin-inline-start:16px!important}</style>';
  const actions = '<div class="gh-header-actions"><button>Subscribe</button><span class="edit-action"><button class="js-details-target">Edit</button></span></div>';
  const { page, settled } = await fixture(`${layout}<main><div class="gh-header js-discussions-title-container"><h1 class="gh-header-title"><span class="js-issue-title">Hello discussion headline</span><span class="gh-header-number"> #24046</span></h1>${actions}</div></main>`, { path: '/owner/repo/discussions/24046' });
  try {
    const toggle = '.gh-header-actions .ght-toggle';
    await page.waitForSelector(toggle + '[data-state="done"]');
    await settled();
    assert.equal(await page.$$eval('h1 .ght-toggle', els => els.length), 0);
    for (const width of [1280, 375]) {
      await page.setViewport({ width, height: 900 });
      const placement = await page.$eval(toggle, el => {
        const button = el.getBoundingClientRect();
        const edit = el.parentElement.nextElementSibling;
        return { neighbour: edit.textContent, gap: edit.getBoundingClientRect().left - button.right, visible: button.width > 0 && button.right <= innerWidth };
      });
      assert.deepEqual(placement, { neighbour: 'Edit', gap: 4, visible: true }, `width ${width}`);
    }
    await page.click(toggle);
    await page.evaluate(html => { document.querySelector('.gh-header-actions').outerHTML = html; }, actions);
    await page.waitForSelector(toggle + '[aria-pressed="true"]');
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 1);
  } finally { await page.close(); }
});

test('modern Issue reaction rows match native button spacing when GitHub replaces the toolbar', async () => {
  const { page, settled } = await fixture(issuePage, { path: '/owner/repo/issues/42' });
  try {
    await page.waitForSelector('[data-testid="issue-body"] [role="toolbar"] .ght-toggle[data-state="done"]');
    await settled();
    await page.click('[data-testid="issue-body"] .ght-toggle');
    await page.evaluate(() => {
      document.querySelector('[data-testid="issue-body"] [role="toolbar"]').outerHTML = '<div role="toolbar" aria-label="Reactions"><button class="smile">Smile</button><button class="thumbs">👍 4</button></div>';
    });
    await page.waitForSelector('[data-testid="issue-body"] [role="toolbar"] .ght-toggle[aria-pressed="true"]');
    assert.equal(await page.$$eval('[data-testid="issue-body"] .ght-toggle', els => els.length), 1);
    assert.deepEqual(await page.$eval('[data-testid="issue-body"] [role="toolbar"]', row => {
      const [smile, reaction, toggle] = [...row.querySelectorAll('button')].map(el => el.getBoundingClientRect());
      return [reaction.left - smile.right, toggle.left - reaction.right];
    }), [4, 4]);
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
    assert.equal(await page.$eval('.gh-header-actions .ght-toggle', el => el.getAttribute('aria-label').startsWith('Discussions:')), true);
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

test('Home translates the dashboard work lists without feed cards or per-row controls', async () => {
  const markup = `
    <main><div class="copilot-prompt" contenteditable>Hello Copilot prompt</div>
      <section><h2>Pull requests</h2><a href="/pulls">View all</a><ul><li>
        <a id="pr" href="/owner/repo/pull/27" data-hovercard-type="pull_request"><span class="fgColor-default">fix(ui): Hello pull request</span>
          <span class="fgColor-muted">owner/repo#27 · Opened by alice · <relative-time>yesterday</relative-time></span>
        </a>
      </li></ul></section>
      <section><h2>Issues</h2><a href="/issues">View all</a><ul id="issues"><li>
        <a id="issue" href="https://github.com/owner/repo/issues/42?source=home">Hello issue</a>
        <a href="/owner/repo/issues/42">owner/repo#42</a>
      </li></ul></section>
      <nav><a href="/owner/repo/issues/43">Hello navigation</a></nav>
      <a href="https://example.com/owner/repo/issues/44">Hello external reference</a>
    </main>`;
  const { page, settled } = await fixture(markup, { path: '/', auto: false });
  try {
    assert.equal(await page.$eval('.ght-fab', el => el.textContent), 'Translate');
    await page.click('.ght-fab');
    await page.waitForFunction(() => document.querySelectorAll('[data-ght-clone]').length === 2);
    await settled();
    assert.deepEqual(await page.$$eval('[data-ght-clone]', els => els.map(el => el.textContent.trim())), [
      'fix(ui): Привет pull request', 'Привет issue',
    ]);
    assert.equal(await page.$eval('#pr .fgColor-muted', el => el.textContent), 'owner/repo#27 · Opened by alice · yesterday');
    assert.equal(await page.$$eval('h2[data-ght-source], .copilot-prompt[data-ght-source], nav [data-ght-source], .ght-control-slot', els => els.length), 0);
    await page.click('.ght-fab');
    await page.$eval('#issues', el => {
      el.insertAdjacentHTML('beforeend', '<li><a href="/owner/repo/issues/45">Hello updated issue</a></li>');
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-ght-clone][data-ght-hidden]').length === 3);
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('#issues [data-ght-clone]:not([data-ght-hidden])', els => els.at(-1).textContent), 'Привет updated issue');
  } finally { await page.close(); }
});

test('Home and Feed use one page switch and preserve identities, timestamps and actions', async () => {
  for (const path of ['/', '/dashboard', '/dashboard-feed', '/feed']) {
    const { page, settled } = await fixture(`<main id="dashboard">${feedCard('first-card')}${feedCard('second-card')}<nav><a href="/owner/repo/issues/43">Hello navigation</a></nav><form><div class="markdown-body">Hello editable preview</div></form></main>`, { path });
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-ght-clone]').length === 6);
      await settled();
      assert.equal(await page.$$eval('#first-card [data-ght-clone]', els => els.length), 3);
      assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
      assert.equal(await page.$eval('#first-card [data-ght-clone] [data-hovercard-type="repository"]', el => el.textContent), 'owner/repo');
      assert.equal(await page.$eval('#first-card p[data-ght-clone] relative-time', el => el.textContent), '2 weeks ago');
      assert.equal(await page.$eval('#first-card .star', el => el.textContent), 'Star');
      assert.equal(await page.$$eval('form [data-ght-clone], nav [data-ght-clone]', els => els.length), 0);
      await page.click('.ght-fab');
      assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => el.hasAttribute('data-ght-hidden'))), true);
      await page.click('.ght-fab');
      assert.equal(await page.$$eval('[data-ght-clone]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
    } finally { await page.close(); }
  }
});

test('legacy feed content and newly loaded cards are translated without duplicating nested content', async () => {
  const { page, settled } = await fixture('<main id="dashboard"><div class="news"><div class="body" id="legacy"><p>Hello activity</p><div class="markdown-body"><p>Hello excerpt</p></div></div></div></main>', { path: '/dashboard-feed' });
  try {
    await page.waitForSelector('#legacy [data-ght-clone]');
    await settled();
    assert.equal(await page.$$eval('#legacy [data-ght-clone]', els => els.length), 2);
    await page.click('.ght-fab');
    await page.evaluate(html => document.querySelector('main').insertAdjacentHTML('beforeend', html), feedCard('late-card'));
    await page.waitForFunction(() => document.querySelectorAll('#late-card [data-ght-clone][data-ght-hidden]').length === 3);
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 0);
    await page.click('.ght-fab');
    assert.equal(await page.$$eval('#late-card [data-ght-clone]:not([data-ght-hidden])', els => els.length), 3);
  } finally { await page.close(); }
});

test('current feed cards translate linked PR titles, excerpts and plain repository descriptions', async () => {
  const repo = (name, description) => `<div>
    <div><a data-hovercard-type="repository" href="/owner/${name}">owner/${name}</a><button>Star</button></div>
    <div class="color-fg-default">${description}</div><div class="fgColor-muted">42 stars</div>
  </div>`;
  const feed = `
    <main><turbo-frame id="feed-list">
      <article class="js-feed-item-component"><div class="fgColor-muted"><a href="/alice">alice</a> starred a repository</div>
        ${repo('starred', 'Hello starred repository')}
      </article>
      <article class="js-feed-item-component">
        <h3><a data-hovercard-type="pull_request" href="/owner/repo/pull/42">Hello pull request</a> <span>#42</span></h3>
        <div class="fgColor-muted">alice merged 1 commit</div>
        <div class="markdown-body"><p>Hello pull request excerpt</p></div>
      </article>
      <article class="js-feed-item-component"><h3>Trending repositories</h3>
        <article>${repo('trending', 'Hello trending repository')}</article>
        ${repo('also-trending', 'Hello another trending repository')}
      </article>
      <article class="js-feed-item-component"><h3>Recommended for you</h3>
        ${repo('recommended', 'Hello recommended repository')}
      </article>
    </turbo-frame></main>`;
  const { page, settled } = await fixture(feed, { path: '/feed' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('[data-ght-clone]').length === 6);
    await settled();
    assert.deepEqual(await page.$$eval('[data-ght-clone]', els => els.map(el => el.textContent.trim())), [
      'Привет starred repository', 'Привет pull request #42', 'Привет pull request excerpt',
      'Привет trending repository', 'Привет another trending repository', 'Привет recommended repository',
    ]);
    assert.equal(await page.$eval('h3[data-ght-clone] a', el => el.getAttribute('href')), '/owner/repo/pull/42');
    assert.equal(await page.$$eval('button:not(.ght-fab)', els => els.every(el => el.textContent === 'Star')), true);
    assert.equal(await page.$$eval('.fgColor-muted[data-ght-hidden], .ght-control-slot', els => els.length), 0);
  } finally { await page.close(); }
});

test('new page settings can disable translation and navigation restores originals and removes source markers', async () => {
  const { page, settled } = await fixture(issuePage, { path: '/owner/repo/issues/42' });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 3);
    await settled();
    await page.evaluate(() => {
      window.__settings.parts = { issues: false };
      for (const listener of window.__storageListeners) listener({ settings: { newValue: window.__settings } }, 'local');
    });
    await page.waitForFunction(() => !document.querySelector('.ght-toggle, [data-ght-clone], [data-ght-source]'));
    await page.evaluate(() => {
      window.__settings.parts = { issues: true };
      for (const listener of window.__storageListeners) listener({ settings: { newValue: window.__settings } }, 'local');
    });
    await page.waitForFunction(() => document.querySelectorAll('.ght-toggle[data-state="done"]').length === 3);
    await page.evaluate(() => { history.pushState({}, '', '/owner/repo/settings'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForFunction(() => !document.querySelector('.ght-fab, .ght-toggle, [data-ght-clone], [data-ght-source]'));
  } finally { await page.close(); }
});

test('the page download control prepares the detected source when translating into English', async () => {
  const { page, settled } = await fixture(comment('pullrequest-1', '你好，Hello'), { target: 'en', detector: 'zh', mode: 'activation' });
  try {
    await page.waitForSelector('.ght-toggle[data-state="activation"]');
    await page.click('.ght-fab');
    await settled();
    assert.deepEqual(await page.evaluate(() => window.__preparedSources), ['zh']);
  } finally {
    await page.close();
  }
});

test('model preparation shows immediate busy feedback and ignores duplicate page clicks', async () => {
  const { page, settled } = await fixture(comment(), { mode: 'waiting-download' });
  try {
    await page.waitForSelector('.ght-toggle[data-state="activation"]');
    await page.click('.ght-fab');
    assert.match(await page.$eval('.ght-fab', el => el.textContent), /Downloading model 0%/);
    assert.equal(await page.$eval('.ght-toggle', el => el.disabled), true);
    await page.click('.ght-fab');
    assert.deepEqual(await page.evaluate(() => window.__preparedSources), ['en']);
    await page.evaluate(() => window.__finishDownload());
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    await settled();
    assert.equal(await page.$eval('.ght-toggle', el => el.disabled), false);
    assert.doesNotMatch(await page.$eval('.ght-fab', el => el.textContent), /Downloading/);
  } finally {
    await page.close();
  }
});


test('auto settings start and stop translation on the current page', async () => {
  const { page } = await fixture(comment(), { auto: false });
  try {
    await page.evaluate(() => {
      window.__settings.auto = true;
      for (const listener of window.__storageListeners) listener({ settings: { newValue: window.__settings } }, 'local');
    });
    await page.waitForSelector('[data-ght-clone]');
    await page.evaluate(() => {
      window.__settings.auto = false;
      for (const listener of window.__storageListeners) listener({ settings: { newValue: window.__settings } }, 'local');
    });
    await page.waitForFunction(() => !document.querySelector('[data-ght-source], [data-ght-clone]'));
    assert.equal(await page.$eval('.ght-fab', el => el.textContent), 'Translate');
  } finally { await page.close(); }
});

test('translated links follow attribute edits and same-text markup replacements', async () => {
  const { page } = await fixture(comment('pullrequest-1', 'Hello <a href="https://example.com/old">documentation</a>'));
  try {
    await page.waitForSelector('[data-ght-clone]');
    await page.evaluate(() => { document.querySelector('[data-ght-source] a').href = 'https://example.com/new'; });
    await page.waitForFunction(() => document.querySelector('[data-ght-clone] a')?.href === 'https://example.com/new');
    await page.evaluate(() => {
      document.querySelector('[data-ght-source] p').innerHTML = 'Hello <strong><a href="https://example.com/latest">documentation</a></strong>';
    });
    await page.waitForFunction(() => document.querySelector('[data-ght-clone] strong a')?.href === 'https://example.com/latest');
  } finally { await page.close(); }
});

test('Chinese script variants translate while matching scripts are skipped', async () => {
  for (const [detector, target, translates] of [['zh', 'zh-Hant', true], ['zh-Hant', 'zh', true], ['zh-TW', 'zh-Hant', false]]) {
    const { page } = await fixture(comment('pullrequest-1', 'Hello 汉语'), { detector, target });
    try {
      await page.waitForFunction(() => window.__requests.includes('detector.detect'));
      if (translates) await page.waitForSelector('[data-ght-clone]');
      else await page.waitForFunction(() => !document.querySelector('.ght-fab').textContent.includes('Translating'));
      assert.equal(await page.evaluate(() => window.__requests.includes('translator.translate')), translates);
    } finally { await page.close(); }
  }
});

test('navigation cancels a stalled request and translates the new page before any old response', async () => {
  const { page } = await fixture(comment(), { mode: 'stalled' });
  try {
    await page.waitForFunction(() => Boolean(window.__hungRequest));
    await page.evaluate(() => {
      window.__cancelled = [];
      window.addEventListener('ght:cancel', event => window.__cancelled.push(JSON.parse(event.detail).id));
      window.__engineMode = 'ready';
      history.pushState({}, '', '/owner/repo/pull/2');
      document.body.innerHTML = '<div class="js-comment" id="pullrequest-2"><div class="markdown-body"><p>Hello new page</p></div></div>';
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForSelector('[data-ght-clone]');
    assert.equal(await page.evaluate(() => window.__cancelled.includes(window.__hungRequest)), true);
    assert.equal(await page.$eval('[data-ght-clone]', el => el.textContent), 'Привет new page');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('ght:res', {
      detail: JSON.stringify({ id: window.__hungRequest, result: ['stale result'] }),
    })));
    assert.equal(await page.$eval('[data-ght-clone]', el => el.textContent), 'Привет new page');
  } finally { await page.close(); }
});

test('returning to a cached repository page resumes README translation without a reload', async () => {
  const repo = '/VPDPersonal/Aspid.Translator.GitHub';
  const readme = '<article class="markdown-body" itemprop="text" style="display:grid!important"><h1 id="overview">Hello README</h1></article>';
  const { page, settled } = await fixture(readme, { path: repo });
  try {
    await page.waitForSelector('[data-ght-clone] #overview');
    await settled();
    const snapshot = await page.evaluate(repo => {
      document.documentElement.dispatchEvent(new CustomEvent('turbo:before-cache', { bubbles: true }));
      window.__repositorySnapshot = document.body.cloneNode(true);
      history.pushState({}, '', `${repo}/issues`);
      document.body.replaceWith(document.createElement('body'));
      document.dispatchEvent(new Event('turbo:load'));
      const body = window.__repositorySnapshot;
      return {
        artifacts: body.querySelectorAll('[data-ght-source], [data-ght-clone], [data-ght-ui], .ght-fab').length,
        display: body.querySelector('article').style.display,
        heading: body.querySelector('article #overview')?.textContent,
      };
    }, repo);
    await page.waitForSelector('.ght-fab');
    await page.evaluate(repo => {
      history.replaceState({}, '', repo);
      document.body.replaceWith(window.__repositorySnapshot);
      document.dispatchEvent(new Event('turbo:load'));
    }, repo);
    await page.waitForFunction(() => window.__translationSources.length === 2, { timeout: 3000 });
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    assert.deepEqual(snapshot, { artifacts: 0, display: 'grid', heading: 'Hello README' });
    assert.equal(await page.$$eval('.ght-fab', buttons => buttons.length), 1);
    await page.click('.ght-toggle');
    assert.equal(await page.$eval('[data-ght-source] #overview', el => el.textContent), 'Hello README');
    assert.equal(await page.$eval('[data-ght-source]', el => getComputedStyle(el).display), 'grid');
  } finally { await page.close(); }
});

test('editing a working source cancels its stale translation', async () => {
  const { page } = await fixture(comment(), { mode: 'stalled' });
  try {
    await page.waitForFunction(() => Boolean(window.__hungRequest));
    await page.evaluate(() => {
      window.__engineMode = 'ready';
      document.querySelector('[data-ght-source] p').textContent = 'Hello edited description';
    });
    await page.waitForSelector('[data-ght-clone]');
    assert.match(await page.$eval('[data-ght-clone]', el => el.textContent), /Привет edited description/);
  } finally { await page.close(); }
});

test('a translation reply arriving just after an edit is never displayed', async () => {
  const { page } = await fixture(comment(), { mode: 'stalled' });
  try {
    await page.waitForFunction(() => Boolean(window.__hungRequest));
    await page.evaluate(() => {
      window.__insertedTranslations = [];
      new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.matches?.('[data-ght-clone]')) window.__insertedTranslations.push(node.querySelector('p').textContent);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
      window.__engineMode = 'ready';
      document.querySelector('[data-ght-source] p').textContent = 'Hello edited description';
      window.dispatchEvent(new CustomEvent('ght:res', {
        detail: JSON.stringify({ id: window.__hungRequest, result: ['Привет description'] }),
      }));
    });
    await page.waitForFunction(() => window.__insertedTranslations.includes('Привет edited description'));
    assert.deepEqual(await page.evaluate(() => window.__insertedTranslations), ['Привет edited description']);
  } finally { await page.close(); }
});


test('enabling auto preserves a manual translation and its original view', async () => {
  const { page } = await fixture(comment(), { auto: false });
  try {
    await page.click('.ght-fab');
    await page.waitForSelector('[data-ght-clone]');
    await page.click('.ght-fab');
    await page.evaluate(() => {
      window.__settings.auto = true;
      for (const listener of window.__storageListeners) listener({ settings: { newValue: window.__settings } }, 'local');
    });
    await page.waitForFunction(() => document.querySelector('.ght-fab').textContent.includes('Translate all'));
    assert.equal(await page.$eval('[data-ght-source]', el => el.hasAttribute('data-ght-hidden')), false);
    await page.click('.ght-fab');
    assert.equal(await page.$eval('[data-ght-source]', el => el.hasAttribute('data-ght-hidden')), true);
  } finally { await page.close(); }
});

test('a removed translation returns without another model call and preserves the source display', async () => {
  const { page } = await fixture('<div class="markdown-body" style="display:grid!important">Hello layout</div>');
  try {
    await page.waitForSelector('[data-ght-clone]');
    await page.$eval('[data-ght-clone]', clone => clone.remove());
    await page.waitForSelector('[data-ght-clone]', { visible: true, timeout: 3000 });
    assert.equal(await page.$eval('[data-ght-clone]', clone => clone.lang), 'ru');
    await page.click('.ght-fab');
    assert.deepEqual(await page.$eval('[data-ght-source]', source => [
      getComputedStyle(source).display, source.style.getPropertyPriority('display'), window.__translationSources.length,
    ]), ['grid', 'important', 1]);
  } finally { await page.close(); }
});

test('removing the last blocked comment clears the download action', async () => {
  const { page } = await fixture(comment(), { mode: 'activation' });
  try {
    await page.waitForSelector('.ght-toggle[data-state="activation"]');
    await page.$eval('#pullrequest-1', el => el.remove());
    await page.waitForFunction(() => document.querySelector('.ght-fab').textContent.includes('Show all originals'));
    await page.click('.ght-fab');
    assert.deepEqual(await page.evaluate(() => window.__preparedSources), []);
  } finally { await page.close(); }
});

test('body replacement and continuous unrelated mutations still allow new comments to translate', async () => {
  const { page } = await fixture(title);
  try {
    await page.waitForSelector('[data-ght-clone]');
    await page.evaluate(html => {
      const body = document.createElement('body');
      body.innerHTML = html;
      document.body.replaceWith(body);
      const clock = document.createElement('time');
      document.body.append(clock);
      window.__ticker = setInterval(() => { clock.textContent = String(Date.now()); }, 50);
    }, comment('late', 'Hello replacement'));
    await page.waitForSelector('#late [data-ght-clone]', { timeout: 4000 });
    await page.evaluate(() => clearInterval(window.__ticker));
    assert.equal(await page.$$eval('.ght-fab', els => els.length), 1);
  } finally { await page.close(); }
});

test('empty and plaintext-only contenteditable drafts stay in the editor', async () => {
  const { page } = await fixture(comment() + '<div contenteditable><p class="markdown-body">Hello draft</p></div><p class="markdown-body" contenteditable="plaintext-only">Hello private draft</p><article id="nested" class="markdown-body"><span contenteditable>Hello edit</span></article>');
  try {
    await page.waitForSelector('#pullrequest-1 [data-ght-clone]');
    assert.equal(await page.$$eval('#nested[data-ght-source], [contenteditable][data-ght-source], [contenteditable] [data-ght-source]', els => els.length), 0);
  } finally { await page.close(); }
});

test('current PR headings share a control and keep the issue number outside the translation', async () => {
  const { page } = await fixture(`
    <div data-component="PageHeader">
      <div data-component="TitleArea"><div class="titleWithAction__abc">
        <h1><span class="markdownTitle__abc">Hello title</span><span class="sr-only"> - #12</span></h1>
      </div></div><div data-component="PH_Actions"><button>Edit</button></div>
    </div>
    <h2 data-component="PH_Title"><a href="#top"><span class="markdownTitle__abc">Hello title</span></a><span>#12</span></h2>`);
  try {
    await page.waitForFunction(() => document.querySelectorAll('[data-ght-clone]').length === 2);
    assert.deepEqual(await page.$$eval('[data-ght-clone]', els => els.map(el => el.textContent)), ['Привет title', 'Привет title']);
    assert.equal(await page.$$eval('.ght-toggle', els => els.length), 1);
    await page.click('[data-component="PH_Actions"] .ght-toggle');
    assert.equal(await page.$$eval('[data-ght-source]', els => els.every(el => !el.hasAttribute('data-ght-hidden'))), true);
  } finally { await page.close(); }
});

test('mixed-language table cells use their own model and preserve paths and original markup', async () => {
  const body = `<div class="markdown-body"><p>Hello review</p><markdown-accessiblity-table><table>
    <thead><tr><th>Layer / File(s)</th></tr></thead><tbody>
    <tr><td><strong>警告去重与缺失条件处理</strong><br><code>src/Observer.ts</code>, <code>tests/Observer.test.ts</code></td></tr>
    <tr><td><a href="#callback">目标选择与回调测试</a> <code>observeAll</code></td></tr>
    <tr><td>Уже по-русски</td></tr></tbody></table></markdown-accessiblity-table></div>`;
  const { page } = await fixture(body, { detector: 'mixed', mode: 'chinese-download' });
  try {
    await page.waitForSelector('.ght-toggle[data-state="activation"]');
    await page.click('.ght-toggle');
    await page.waitForSelector('.ght-toggle[data-state="done"]');
    assert.deepEqual(await page.evaluate(() => window.__preparedSources), ['zh']);
    assert.deepEqual(await page.evaluate(() => window.__translationSources), ['en', 'zh', 'en', 'zh']);
    const clone = '[data-ght-clone]';
    assert.equal(await page.$eval(clone + ' th', el => el.textContent), 'Слой / Файлы');
    assert.equal(await page.$eval(clone + ' td strong', el => el.textContent), 'Обработка предупреждений');
    assert.deepEqual(await page.$eval(clone + ' td a', el => [el.textContent, el.getAttribute('href')]), ['Проверка обратного вызова', '#callback']);
    assert.deepEqual(await page.$$eval(clone + ' td code', els => els.map(el => el.textContent)), ['src/Observer.ts', 'tests/Observer.test.ts', 'observeAll']);
    assert.equal(await page.$eval(clone + ' tr:last-child td', el => el.textContent), 'Уже по-русски');
    await page.click('.ght-toggle');
    assert.equal(await page.$eval('[data-ght-source] td strong', el => el.textContent), '警告去重与缺失条件处理');
  } finally { await page.close(); }
});

test('a table translates foreign cells when the surrounding review is in the target language', async () => {
  const { page } = await fixture('<div class="markdown-body"><p>Hello review</p><table><tr><td>目标选择与回调测试</td></tr></table></div>', { target: 'en', detector: 'mixed' });
  try {
    await page.waitForSelector('[data-ght-clone] td');
    assert.deepEqual(await page.evaluate(() => window.__translationSources), ['zh']);
    assert.equal(await page.$eval('[data-ght-clone] p', el => el.textContent), 'Hello review');
    assert.equal(await page.$eval('[data-ght-clone] td', el => el.textContent), 'Callback test');
  } finally { await page.close(); }
});
