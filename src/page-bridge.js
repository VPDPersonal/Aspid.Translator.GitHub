// Content-side client for bridge.js, which runs in the page's MAIN world where Chrome exposes
// the on-device Translator and LanguageDetector APIs. Both sides talk through window events
// with JSON string payloads.

import { t } from './i18n.js';
import { targetFor } from './settings.js';

let seq = 0;
const pending = new Map();
let progressListener = null;
let listening = false;

// Listeners are added on first use, so importing this module has no side effects.
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('ght:res', (event) => {
    const message = JSON.parse(event.detail);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) {
      const text = message.code === 'Unsupported' ? t('errorUnsupported') : message.error;
      request.reject(Object.assign(new Error(text), { code: message.code }));
    } else {
      request.resolve(message.result);
    }
  });
  window.addEventListener('ght:progress', (event) => progressListener?.(JSON.parse(event.detail).loaded));
}

// Dispatch is synchronous, so a call made inside a click handler keeps the user activation.
export function callBridge(op, args) {
  listen();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
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
  try {
    const [top] = await callBridge('detector.detect', { text });
    return top ?? null;
  } catch {
    return detectWithCld(text);
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
