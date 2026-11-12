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
    pending.delete(message.id);
    clearTimeout(request.timer);
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
export function callBridge(op, args) {
  listen();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const request = { resolve, reject, timer: null, arm: () => {
      clearTimeout(request.timer);
      request.timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(t('errorTimeout')), { code: 'TimeoutError' }));
        window.dispatchEvent(new CustomEvent('ght:cancel', { detail: JSON.stringify({ id }) }));
        progressListener?.(1); // Clear a stalled download indicator so Retry remains visible.
      }, TIMEOUTS[op] ?? DOWNLOAD_TIMEOUT);
    } };
    pending.set(id, request);
    request.arm();
    window.dispatchEvent(new CustomEvent('ght:req', { detail: JSON.stringify({ id, op, args }) }));
  });
}

/** Calls `listener` with the 0..1 progress of a model download. */
export function onDownloadProgress(listener) {
  listen();
  progressListener = listener;
}

/**
 * Returns the most likely language of `text` as `{ lang, confidence }`, or null.
 * Falls back to chrome.i18n when the LanguageDetector model is missing or waits for a download:
 * Chromium-based browsers such as Dia never get that model.
 */
export async function detectLanguage(text) {
  let top = null;
  try {
    [top] = await callBridge('detector.detect', { text });
  } catch {
    // chrome.i18n can detect languages without a downloaded model.
  }
  if (top?.lang === 'und') return top;
  const plausible = top && matchesScript(top.lang, text);
  if (plausible && top.confidence >= 0.4 && targetFor(top.lang)) return top;
  // A short technical title can be confidently misidentified as an unsupported language.
  // Check an independent detector before asking Translator to use that language pair.
  const fallback = await detectWithCld(text).catch(() => null);
  if (fallback && fallback.lang !== 'und') return fallback;
  return plausible ? top : null;
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
  if (!matchesScript(guess.lang, text)) return null;
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
export const prepareDetector = () => callBridge('detector.prepare');
