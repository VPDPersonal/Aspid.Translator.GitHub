import { t } from './i18n.js';
import { loadSettings, normalizeSettings, languageName, targetFor } from './settings.js';
import {
  applyTranslation, cloneForTranslation, collectPlainSegments, collectSegments, hasLetters, linkEmbeds, placeEmbeds,
  protectNames, protectPrefix, stripTags, textOf,
} from './dom.js';
import { createLanguageDetector, onDownloadProgress, prepareDetector } from './page-bridge.js';
import { getProvider } from './providers/index.js';
import { ABOUT_SELECTOR, controlScope, createControl, directoryMessages, placeControl, removeControl } from './controls.js';
import { FEED_CARD, PR_TITLES, REFERENCED_COMMIT, extraTargets, feedContent, pageOf } from './pages.js';

const README_SELECTOR = 'article.markdown-body[itemprop="text"], #readme .markdown-body';
const EXCLUDE_SELECTOR = [
  '.js-preview-body', '[data-ght-clone]', '.prose-diff',
  '.rich-diff', '.js-file-content', '[data-ght-ui]', '[class*="MarkdownEditor"]', '[class*="markdown-editor"]',
  '[role="dialog"]', 'dialog', '.Overlay',
].join(',');

// Segmenters for rendered markdown, one-line titles and plain-text commit bodies.
const TARGETS = [
  {
    mode: 'block',
    kind: 'about',
    selector: ABOUT_SELECTOR,
  },
  {
    mode: 'inline',
    kind: 'commitTitles',
    find: directoryMessages,
  },
  {
    mode: 'inline',
    kind: 'prTitle',
    pages: ['pull'],
    selector: PR_TITLES,
  },
  {
    mode: 'inline',
    kind: 'commitTitles',
    pages: ['pull', 'commit', 'commits', 'repo'],
    selector: [
      '.js-details-container code:has(> a.markdown-title)', // PR conversation timeline
      '[data-testid="commit-row-item"] h4 > span', // commit lists
      '[data-testid="commit-row-item"] h4 > a > span', // current GitHub commit lists
      '[class*="commitMessageContainer"] > span:not(.extended-commit-description-container)', // commit page
    ].join(','),
  },
  {
    mode: 'plain',
    kind: 'commitBodies',
    pages: ['pull', 'commit', 'commits', 'repo'],
    selector: '.extended-commit-description-container, .js-details-container .Details-content--hidden > pre',
  },
  {
    mode: 'inline',
    kind: 'commitTitles',
    pages: ['issue', 'pull'],
    selector: `${REFERENCED_COMMIT} [class*="commitMessageText"] .markdown-body`,
  },
  {
    mode: 'plain',
    kind: 'commitBodies',
    pages: ['issue', 'pull'],
    selector: `${REFERENCED_COMMIT} > .markdown-body > p`,
  },
  { mode: 'block', kind: null, selector: '.markdown-body' },
];

function markdownKind(el) {
  if (el.closest(REFERENCED_COMMIT)) return el.closest('[class*="commitMessageText"]') ? 'commitTitles' : 'commitBodies';
  const pageParts = { issue: 'issues', discussion: 'discussions', discussionList: 'discussions', releases: 'releases', wiki: 'wiki', lists: 'lists' };
  if (pageParts[state.pageKind]) return pageParts[state.pageKind];
  if (state.pageKind === 'home' || state.pageKind === 'feed') return el.closest(FEED_CARD) ? 'feed' : null;
  if (state.pageKind === 'compare') return null;
  if (el.matches(README_SELECTOR)) return 'readme';
  if (el.closest('[id^="pullrequest-"]')) return 'prBody';
  const review = [
    '.review-comment', '.review-thread-component', '.js-resolvable-timeline-thread-container',
    '[id^="discussion_r"]', '[id^="pullrequestreview-"]', '[data-testid*="review-thread"]',
    '[class*="ReviewThread"]',
  ].join(',');
  return el.closest(review) ? 'reviewComments' : 'comments';
}

const state = {
  settings: null,
  provider: null,
  url: '',
  pageKey: '',
  pageKind: '',
  pageAlways: false,
  active: false,
  showOriginal: false,
  downloadProgress: null,
  preparingModels: null,
  preparationController: null,
  jobs: new Map(), // translated element -> job
  groups: new Map(), // comment, title, document or commit -> shared local control
  queue: [],
  running: 0,
};
let fab = null;

onDownloadProgress((loaded) => {
  state.downloadProgress = loaded < 1 ? loaded : null;
  for (const group of state.groups.values()) updateControl(group);
  updateFab();
});

const sameLanguage = (a, b) => (targetFor(a) ?? a.toLowerCase()) === (targetFor(b) ?? b.toLowerCase());

// ---------------------------------------------------------------------------------------------
// Translation of one element.

async function groupBySource(segments, provider, target, signal) {
  const detectLanguage = createLanguageDetector({ signal });
  const batches = new Map();
  const guesses = new Map();
  for (const segment of segments) {
    signal.throwIfAborted();
    const sample = stripTags(segment.text).slice(0, 2000);
    if (!hasLetters(sample)) continue;
    if (!guesses.has(sample)) {
      guesses.set(sample, await detectLanguage(sample));
    }
    const detected = guesses.get(sample);
    if (detected?.lang === 'und') continue;
    let source = detected?.lang;
    if (provider.needsSource && (!source || detected.confidence < 0.4)) source = 'en';
    if (source && sameLanguage(source, target) && (provider.needsSource || detected.confidence >= 0.5)) continue;
    if (provider.plainText) protectNames(segment, { capitalized: Boolean(source) && sameLanguage(source, 'en') });
    if (!hasLetters(stripTags(segment.text))) continue;
    if (!batches.has(source)) batches.set(source, []);
    batches.get(source).push(segment);
  }
  return batches;
}

/** Translates a detached copy, keeping each paragraph or table cell in its original position. */
async function translateElement(job) {
  const { provider, settings: { target } } = state;
  const { signal } = job.controller;
  signal.throwIfAborted();
  const clone = cloneForTranslation(job.el);
  const segments = job.mode === 'plain' ? collectPlainSegments(clone) : collectSegments(clone);
  if (job.mode === 'inline') segments.forEach(protectPrefix);

  const batches = await groupBySource(segments, provider, target, signal);
  job.sources.clear();
  let changed = false;
  for (const [source, batch] of batches) {
    signal.throwIfAborted();
    // A model download must prepare the specific pair that requested activation.
    job.modelSource = source;
    const result = await provider.translate({ texts: batch.map(segment => segment.text), source, target, signal });
    signal.throwIfAborted();
    const language = source ?? result.sourceLanguage;
    batch.forEach((segment, index) => {
      const translated = result.translations[index]?.trim();
      if (translated && translated !== segment.text) {
        applyTranslation(segment, translated);
        changed = true;
        if (language) job.sources.add(language);
      }
    });
  }
  return changed ? clone : null;
}

// ---------------------------------------------------------------------------------------------
// Jobs: one per element, translated lazily when it scrolls near the viewport.

const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    io.unobserve(entry.target);
    const job = state.jobs.get(entry.target);
    if (job?.status === 'pending') enqueue(job);
  }
}, { rootMargin: '600px 0px' });

const isCurrent = (job) => state.jobs.get(job.el) === job;

const EDITABLE = '[contenteditable=""], [contenteditable="true" i], [contenteditable="plaintext-only" i]';
function overlapsEditor(el) {
  return el.closest(EDITABLE) || el.querySelector(EDITABLE);
}

function scan() {
  if (!state.active) return;
  const { parts } = state.settings;
  for (const target of [...extraTargets(state.pageKind), ...TARGETS]) {
    if (target.pages && !target.pages.includes(state.pageKind)) continue;
    if (target.kind && !parts[target.kind]) continue;
    for (const el of target.find ? target.find() : document.querySelectorAll(target.selector)) {
      const excluded = el.closest(EXCLUDE_SELECTOR);
      if (state.jobs.has(el) || excluded || overlapsEditor(el) || (!target.allowInForm && el.closest('form')) || !hasLetters(el.textContent)) continue;
      if (el.closest('[data-ght-source]') || el.querySelector('[data-ght-source]')) continue;
      let kind = target.kind;
      if (target.mode === 'block') {
        if (el.querySelector('.markdown-body')) continue; // translate the innermost body only
        kind ??= markdownKind(el);
        if (!parts[kind]) continue;
      }
      const job = {
        el, kind, mode: target.mode, status: 'pending', showOriginal: state.showOriginal,
        clone: null, embeds: [], sources: new Set(), modelSource: null, text: '', errorText: null, group: null,
        controller: new AbortController(), dirty: false,
      };
      state.jobs.set(el, job);
      el.setAttribute('data-ght-source', '');
      attachGroup(job);
      io.observe(el);
    }
  }
}

function enqueue(job) {
  job.status = 'queued';
  job.errorText = null;
  state.queue.push(job);
  pump();
}

function pump() {
  while (state.running < state.provider.concurrency && state.queue.length) {
    const job = state.queue.shift();
    if (!isCurrent(job)) continue;
    state.running++;
    processJob(job).finally(() => {
      state.running--;
      pump();
    });
  }
  updateFab();
}

async function processJob(job) {
  job.status = 'working';
  job.text = textOf(job.el);
  updateControl(job.group);
  try {
    const clone = await translateElement(job);
    if (!isCurrent(job)) return;
    if (!clone) {
      job.status = 'skipped';
      updateControl(job.group);
      return;
    }
    clone.lang = state.settings.target;
    job.clone = clone;
    job.embeds = linkEmbeds(job.el, clone);
    job.el.after(clone);
    job.status = 'done';
    render(job);
    updateControl(job.group);
  } catch (error) {
    if (!isCurrent(job)) return;
    if (error.code === 'activation') {
      job.status = 'activation';
      job.errorText = t('labelNeedsModel');
    } else {
      job.status = 'error';
      job.errorText = t('labelError', error.message);
    }
    updateControl(job.group);
    updateFab();
  }
}

function retry(job) {
  if (!isCurrent(job)) return;
  enqueue(job);
}

// Must be called from a click handler: model downloads need a user gesture.
function prepareModels(source = 'en') {
  if (state.preparingModels) return;
  const { provider, settings: { target } } = state;
  // The detector is optional because chrome.i18n can also identify the source language.
  const controller = new AbortController();
  state.preparationController = controller;
  const { signal } = controller;
  prepareDetector({ signal }).catch(() => {});
  const download = provider.prepare && !sameLanguage(source, target) ? provider.prepare({ source, target, signal }) : null;
  const preparation = Promise.resolve(download);
  state.preparingModels = preparation;
  for (const group of state.groups.values()) updateControl(group);
  updateFab();
  preparation.then(
    () => {
      if (state.preparingModels !== preparation) return;
      state.preparingModels = null;
      state.downloadProgress = null;
      for (const job of state.jobs.values()) if (job.status === 'activation') retry(job);
      updateFab();
    },
    (error) => {
      if (state.preparingModels !== preparation) return;
      state.preparingModels = null;
      state.downloadProgress = null;
      for (const job of state.jobs.values()) {
        if (job.status === 'activation') {
          job.errorText = t('labelDownloadFailed', error.message);
          updateControl(job.group);
        }
      }
      updateFab();
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Rendering.

// Inline !important beats GitHub utilities such as `.d-block { display: block !important }`.
const originalDisplay = new WeakMap();
function setHidden(node, hidden) {
  if (hidden) {
    if (originalDisplay.has(node)) return;
    originalDisplay.set(node, [node.style.display, node.style.getPropertyPriority('display')]);
    node.setAttribute('data-ght-hidden', '');
    node.style.setProperty('display', 'none', 'important');
  } else if (originalDisplay.has(node)) {
    node.removeAttribute('data-ght-hidden');
    if (node.style.display === 'none' && node.style.getPropertyPriority('display') === 'important') {
      node.style.setProperty('display', ...originalDisplay.get(node));
    }
    originalDisplay.delete(node);
  }
}

function attachGroup(job) {
  const scope = controlScope(job.el, job.kind);
  let group = state.groups.get(scope.root);
  if (!group) {
    group = { ...scope, jobs: new Set(), showOriginal: state.showOriginal, control: null };
    state.groups.set(scope.root, group);
  }
  group.jobs.add(job);
  job.group = group;
  job.showOriginal = group.showOriginal;
}

function detachGroup(job) {
  const group = job.group;
  if (!group) return;
  group.jobs.delete(job);
  job.group = null;
  if (group.jobs.size) updateControl(group);
  else {
    removeControl(group);
    state.groups.delete(group.root);
  }
}

function onControlClick(group) {
  const activation = [...group.jobs].find(job => job.status === 'activation');
  if (activation) {
    prepareModels(activation.modelSource);
    return;
  }
  const errors = [...group.jobs].filter(job => job.status === 'error');
  if (errors.length) {
    errors.forEach(retry);
    return;
  }
  group.showOriginal = !group.showOriginal;
  for (const job of group.jobs) {
    job.showOriginal = group.showOriginal;
    if (job.status === 'done') render(job);
  }
  updateControl(group);
}

function updateControl(group) {
  if (!group || group.local === false) return;
  const jobs = [...group.jobs];
  const activation = jobs.find(job => job.status === 'activation');
  const error = jobs.find(job => job.status === 'error');
  const busy = jobs.some(job => job.status === 'working' || job.status === 'queued');
  const done = jobs.some(job => job.status === 'done');
  if (!activation && !error && !busy && !done) {
    removeControl(group);
    return;
  }
  group.control ??= createControl(() => onControlClick(group));
  const { button, label } = group.control;
  let text, hint, status;
  if (activation) {
    status = 'activation';
    text = t('actionDownload');
    hint = activation.errorText;
  } else if (error) {
    status = 'error';
    text = t('actionRetry');
    hint = error.errorText;
  } else if (busy) {
    status = 'loading';
    text = hint = t('labelTranslating');
  } else {
    status = 'done';
    text = t(group.kind === 'directory'
      ? group.showOriginal ? 'fabTranslateAll' : 'fabShowOriginals'
      : group.showOriginal ? 'actionShowTranslation' : 'actionShowOriginal');
    const from = [...new Set(jobs.flatMap(job => [...job.sources]))].map(code => languageName(code)).join(', ') || t('sourceUnknown');
    hint = group.showOriginal ? t('labelOriginal', from) : t('labelTranslated', from, languageName(state.settings.target));
  }
  const downloading = activation && (state.preparingModels || state.downloadProgress !== null);
  if (downloading) text = hint = t('fabDownloading', Math.round((state.downloadProgress ?? 0) * 100));
  const scopeKey = group.kind === 'commit' || group.kind === 'directory' ? 'settingsGroupCommits'
    : group.kind === 'document' ? 'partReadme'
      : `part${jobs[0].kind.charAt(0).toUpperCase()}${jobs[0].kind.slice(1)}`;
  button.disabled = status === 'loading' || Boolean(downloading);
  button.dataset.state = status;
  button.setAttribute('aria-label', `${t(scopeKey)}: ${text}`);
  button.setAttribute('aria-description', hint);
  button.setAttribute('aria-busy', String(button.disabled));
  if (status === 'done') button.setAttribute('aria-pressed', String(group.showOriginal));
  else button.removeAttribute('aria-pressed');
  button.title = `${hint}\n${text}`;
  if (label.textContent !== text) label.textContent = text;
  placeControl(group);
}

// Moves element ids to whichever copy is visible, so in-page anchors keep working.
function moveIds(job, toClone) {
  for (const node of job.clone.querySelectorAll('[data-ght-id]')) {
    const id = node.getAttribute('data-ght-id');
    if (toClone) {
      const original = job.el.querySelector(`[id="${CSS.escape(id)}"]`);
      if (!original) continue;
      original.removeAttribute('id');
      original.setAttribute('data-ght-id', id);
      node.id = id;
    } else if (node.id) {
      node.removeAttribute('id');
      const original = job.el.querySelector(`[data-ght-id="${CSS.escape(id)}"]`);
      if (original) {
        original.id = id;
        original.removeAttribute('data-ght-id');
      }
    }
  }
}

function render(job) {
  setHidden(job.el, !job.showOriginal);
  setHidden(job.clone, job.showOriginal);
  moveIds(job, !job.showOriginal);
  placeEmbeds(job.embeds, !job.showOriginal);
  if (job.mode !== 'block') {
    const from = [...job.sources].map(code => languageName(code)).join(', ') || t('sourceUnknown');
    job.clone.title = t('tooltipOriginal', from, job.el.textContent.trim());
  }
}

function removeTranslation(job) {
  job.controller.abort();
  io.unobserve(job.el);
  if (job.clone) moveIds(job, false);
  placeEmbeds(job.embeds, false);
  for (const { home } of job.embeds) home.remove();
  job.clone?.remove();
  job.el.removeAttribute('data-ght-source');
  setHidden(job.el, false);
  detachGroup(job);
}

// ---------------------------------------------------------------------------------------------
// Floating button.

function ensureFab() {
  if (fab?.isConnected) return;
  fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'ght-fab';
  fab.addEventListener('click', onFabClick);
  document.body.append(fab);
  updateFab();
}

function removeFab() {
  fab?.remove();
  fab = null;
}

function pageErrors() {
  return [...state.jobs.values()].filter(job => job.group?.local === false && job.status === 'error');
}

function updateFab() {
  if (!fab) return;
  const busy = state.queue.length + state.running;
  const error = pageErrors()[0];
  let text;
  if (state.preparingModels || state.downloadProgress !== null) text = t('fabDownloading', Math.round((state.downloadProgress ?? 0) * 100));
  else if (!state.active) text = t('fabTranslate');
  else if (activationJob()) text = t('fabDownloadModel');
  else if (busy) text = t('fabTranslating', busy);
  else if (error) text = t('actionRetry');
  else text = t(state.showOriginal ? 'fabTranslateAll' : 'fabShowOriginals');
  if (fab.textContent !== text) fab.textContent = text;
  fab.title = error && !busy ? `${error.errorText}\n${text}` : t('fabTooltip', languageName(state.settings.target), state.provider.title);
  fab.setAttribute('aria-label', text);
}

function activationJob() {
  return [...state.jobs.values()].find(job => job.status === 'activation');
}

function onFabClick() {
  const activation = activationJob();
  if (!state.active || activation) prepareModels(activation?.modelSource);
  if (!state.active) {
    start();
    return;
  }
  if (activation) return;
  const errors = pageErrors();
  if (errors.length) {
    errors.forEach(retry);
    return;
  }
  state.showOriginal = !state.showOriginal;
  for (const group of state.groups.values()) group.showOriginal = state.showOriginal;
  for (const job of state.jobs.values()) {
    job.showOriginal = state.showOriginal;
    if (job.status === 'done') render(job);
  }
  for (const group of state.groups.values()) updateControl(group);
  updateFab();
}

// ---------------------------------------------------------------------------------------------
// Lifecycle.

function start() {
  state.active = true;
  state.showOriginal = false;
  scan();
  updateFab();
}

function stop() {
  state.active = false;
  state.preparingModels = null;
  state.preparationController?.abort();
  state.preparationController = null;
  state.downloadProgress = null;
  for (const job of state.jobs.values()) removeTranslation(job);
  state.jobs.clear();
  state.groups.clear();
  state.queue.length = 0;
  updateFab();
}

// Repository descriptions and commit messages can be translated without a README.
function syncFab() {
  const visible = state.pageKey
    && (state.pageAlways || (state.settings.parts.readme && document.querySelector(README_SELECTOR))
      || (state.settings.parts.commitTitles && directoryMessages().length)
      || (state.settings.parts.about && document.querySelector(ABOUT_SELECTOR))
      || (state.settings.parts.feed && ['home', 'feed'].includes(state.pageKind) && feedContent().length));
  if (visible) ensureFab();
  else removeFab();
}

function onLocationChange() {
  if (location.href === state.url) return;
  state.url = location.href;
  const page = pageOf(location.pathname);
  if (!page) {
    stop();
    state.pageKey = '';
    state.pageKind = '';
    syncFab();
    return;
  }
  if (page.key !== state.pageKey) {
    state.pageKey = page.key;
    state.pageKind = page.kind;
    state.pageAlways = page.always;
    stop();
    if (state.settings.auto) start();
  }
  syncFab();
}

// Drops translations of removed elements and re-translates elements whose text changed.
function maintain() {
  onLocationChange();
  syncFab();
  if (!state.active) return;
  for (const job of [...state.jobs.values()]) {
    const settled = job.status === 'done' || job.status === 'skipped' || job.status === 'error';
    if (!job.el.isConnected || job.dirty || overlapsEditor(job.el) || (settled && textOf(job.el) !== job.text)) {
      removeTranslation(job);
      state.jobs.delete(job.el);
      continue;
    }
    if (job.clone && job.clone.parentNode !== job.el.parentNode) job.el.after(job.clone);
    if (controlScope(job.el, job.kind).root !== job.group.root) {
      detachGroup(job);
      attachGroup(job);
      if (job.status === 'done') render(job);
    }
  }
  scan();
  for (const group of state.groups.values()) updateControl(group);
  updateFab();
}

let maintainTimer = 0;
function scheduleMaintain() {
  if (maintainTimer) return;
  maintainTimer = setTimeout(() => {
    maintainTimer = 0;
    maintain();
  }, 250);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message === 'toggle-translation' && fab?.isConnected) onFabClick();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const previous = state.settings;
  const settings = normalizeSettings(changes.settings.newValue);
  applySettings(settings);
  if (!previous || !state.pageKey) return;
  const changed = previous.provider !== settings.provider || previous.target !== settings.target
    || Object.keys(settings.parts).some(key => previous.parts[key] !== settings.parts[key]);
  if (changed) {
    const wasActive = state.active;
    stop();
    if (settings.auto || (wasActive && previous.auto === settings.auto)) start();
  } else if (previous.auto !== settings.auto) {
    if (!settings.auto) stop();
    else if (!state.active) start();
  }
  syncFab();
  updateFab();
});

function applySettings(settings) {
  state.settings = settings;
  state.provider = getProvider(settings.provider);
}

(async () => {
  const initialSettings = await loadSettings();
  if (!state.settings) applySettings(initialSettings);
  onLocationChange();
  const ownUI = node => (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-ght-ui], [data-ght-clone], .ght-fab');
  const movedEmbed = node => node.nodeType === 8 && node.nodeValue === 'ght-embed'
    || node.nodeType === 1 && node.matches('.render-needs-enrichment');
  new MutationObserver(records => {
    let changed = false;
    for (const record of records) {
      if (ownUI(record.target)) continue;
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest('.render-needs-enrichment')) continue;
      if (record.type === 'childList' && [...record.removedNodes].some(node =>
        node.nodeType === 1 && !node.isConnected && node.matches('[data-ght-clone], [data-ght-ui], .ght-fab'))) changed = true;
      if (record.type === 'childList'
        && [...record.addedNodes, ...record.removedNodes].every(node => ownUI(node) || movedEmbed(node))) continue;
      const source = target?.closest('[data-ght-source]');
      const job = state.jobs.get(source);
      if (job) job.dirty = true;
      changed = true;
    }
    if (changed) scheduleMaintain();
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['contenteditable', 'hidden', 'aria-hidden', 'aria-pressed', 'class', 'href', 'src', 'srcset', 'alt', 'title', 'checked', 'value', 'colspan', 'rowspan'],
  });
  document.addEventListener('turbo:load', scheduleMaintain);
  window.addEventListener('popstate', scheduleMaintain);
})();
