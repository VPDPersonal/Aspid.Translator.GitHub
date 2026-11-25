// Content-side client for bridge.js, which runs in the page's MAIN world where Chrome exposes
// the on-device Translator and LanguageDetector APIs. Both sides talk through window events
// with JSON string payloads.

import { t } from './i18n.js';
import { targetFor } from './settings.js';

let seq = 0;
const pending = new Map();
let progressListener = null;
let listening = false;

// Detection must fall back promptly; model downloads get a separate, longer deadline.
const TIMEOUTS = { 'detector.detect': 15000, 'translator.translate': 120000 };
const DOWNLOAD_TIMEOUT = 15 * 60 * 1000;

function payload(event) {
  try {
    const value = JSON.parse(event.detail);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// Listeners are added on first use, so importing this module has no side effects.
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('ght:res', (event) => {
    const message = payload(event);
    if (!message) return;
    const request = pending.get(message.id);
    if (!request) return;
    request.cleanup();
    if (message.error) {
      const text = message.code === 'Unsupported' ? t('errorUnsupported') : message.error;
      request.reject(Object.assign(new Error(text), { code: message.code }));
    } else {
      request.resolve(message.result);
    }
  });
  window.addEventListener('ght:progress', (event) => {
    const message = payload(event);
    if (typeof message?.loaded === 'number' && message.loaded >= 0 && message.loaded <= 1) {
      progressListener?.(message.loaded);
    }
  });
  window.addEventListener('ght:activity', (event) => {
    const message = payload(event);
    if (message) pending.get(message.id)?.arm();
  });
}

// Dispatch is synchronous, so a call made inside a click handler keeps the user activation.
export function callBridge(op, args, { signal } = {}) {
  listen();
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const id = ++seq;
    let timer;
    const cleanup = () => {
      pending.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const cancel = error => {
      cleanup();
      reject(error);
      window.dispatchEvent(new CustomEvent('ght:cancel', { detail: JSON.stringify({ id }) }));
    };
    const abort = () => cancel(signal.reason);
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        cancel(Object.assign(new Error(t('errorTimeout')), { code: 'TimeoutError' }));
        progressListener?.(1); // Clear a stalled download indicator so Retry remains visible.
      }, TIMEOUTS[op] ?? DOWNLOAD_TIMEOUT);
    };
    pending.set(id, { resolve, reject, cleanup, arm });
    signal?.addEventListener('abort', abort, { once: true });
    arm();
    window.dispatchEvent(new CustomEvent('ght:req', { detail: JSON.stringify({ id, op, args }) }));
  });
}

/** Calls `listener` with the 0..1 progress of a model download. */
export function onDownloadProgress(listener) {
  listen();
  progressListener = listener;
}

/** Detects the segments of one element without retrying a stalled model for every cell. */
export function createLanguageDetector({ signal } = {}) {
  let useModel = true;
  return async text => {
    signal?.throwIfAborted();
    let top = null;
    if (useModel) {
      try {
        [top] = await callBridge('detector.detect', { text }, { signal });
      } catch {
        signal?.throwIfAborted();
        useModel = false;
      }
    }
    signal?.throwIfAborted();
    // Validate the script of the supported language pair: short English labels such as
    // "Run ID" can be misidentified as romanized Arabic.
    const target = top && targetFor(top.lang);
    const plausible = top && top.lang !== 'und' && matchesScript(target ?? top.lang, text);
    if (plausible && top.confidence >= 0.4 && target) return top;
    const fallback = await detectWithCld(text).catch(() => null);
    signal?.throwIfAborted();
    if (fallback && fallback.lang !== 'und') return fallback;
    return plausible || top?.lang === 'und' ? top : null;
  };
}

function matchesScript(language, text) {
  if (language === 'und') return true;
  if (!/\p{L}/u.test(text)) return false;
  try {
    const script = new Intl.Locale(language).maximize().script;
    // Unicode groups Chinese, Japanese and Korean differently from BCP 47 scripts.
    const scripts = { Hans: ['Han'], Hant: ['Han'], Jpan: ['Han', 'Hiragana', 'Katakana'], Kore: ['Hangul', 'Han'] };
    return (scripts[script] ?? [script]).some(value => new RegExp(`\\p{Script=${value}}`, 'u').test(text));
  } catch {
    return false;
  }
}

// Words of letters only: identifiers, paths, versions and sizes are not prose.
const plainWords = (text) => text.split(/\s+/)
  .map((word) => word.replace(/^[("'`[]+|[)"'`\],.:;!?]+$/g, ''))
  .filter((word) => /^\p{L}+(?:['’]\p{L}+)?$/u.test(word))
  .join(' ');

// CLD3, built into Chromium, so it needs no model download.
async function detectWithCld(text) {
  const { languages: [top] } = await chrome.i18n.detectLanguage(text);
  if (!top) return null;
  const guess = { lang: top.language, confidence: top.percentage / 100 };
  if (guess.lang !== 'und' && !matchesScript(targetFor(guess.lang) ?? guess.lang, text)) return null;
  // `und` would maximize to English, so it is checked by name.
  if (['en', 'und'].includes(guess.lang) || new Intl.Locale(guess.lang).maximize().script !== 'Latn') return guess;
  // CLD3 tells scripts apart well, but often takes English technical text for another Latin-script
  // language: Catalan for a commit title, Dutch for a list of packages, Maltese for a bundle size
  // table. Such a guess stands only when the plain words give it again, reliably, and the
  // Translator supports the language.
  const second = await chrome.i18n.detectLanguage(plainWords(text));
  const confirmed = second.isReliable && second.languages[0]?.language === guess.lang;
  return confirmed && targetFor(guess.lang) ? guess : null;
}

/** Downloads the language detector model. Call it inside a user gesture. */
export const prepareDetector = (options) => callBridge('detector.prepare', undefined, options);
