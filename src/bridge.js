// Runs in the page's MAIN world, where Chrome exposes the on-device Translator and
// LanguageDetector APIs. The isolated content script talks to it through window events
// with JSON string payloads.
(() => {
  if (window.__ghtBridge) return;
  window.__ghtBridge = true;

  let detectorPromise = null;
  const translatorPromises = new Map();

  const emit = (type, payload) =>
    window.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(payload) }));

  const monitor = (m) =>
    m.addEventListener('downloadprogress', (event) => emit('ght:progress', { loaded: event.loaded }));

  function unsupported(api) {
    // The content script shows its own localized text for this error name.
    const error = new Error(`${api} API is not available in this browser: it needs desktop Chrome 138 or newer.`);
    error.name = 'Unsupported';
    return error;
  }

  // create() must be called synchronously inside a user gesture when a model needs a download,
  // so these helpers start the call before their first await.
  function getDetector() {
    if (!('LanguageDetector' in self)) return Promise.reject(unsupported('Language Detector'));
    detectorPromise ??= LanguageDetector.create({ monitor }).catch((error) => {
      detectorPromise = null;
      throw error;
    });
    return detectorPromise;
  }

  function getTranslator(sourceLanguage, targetLanguage) {
    if (!('Translator' in self)) return Promise.reject(unsupported('Translator'));
    const key = `${sourceLanguage}>${targetLanguage}`;
    if (!translatorPromises.has(key)) {
      const promise = Translator.create({ sourceLanguage, targetLanguage, monitor }).catch((error) => {
        translatorPromises.delete(key);
        throw error;
      });
      translatorPromises.set(key, promise);
    }
    return translatorPromises.get(key);
  }

  // An abort, a missing user gesture or an input over the quota says nothing about the instance.
  const KEEP_INSTANCE = new Set(['AbortError', 'NotAllowedError', 'QuotaExceededError']);

  // Calls `use` with the instance from the cached `promise`. After the on-device service restarts,
  // for example while another language pack downloads, the instance fails every call, so a failed
  // call drops it from the cache through `forget` and the next call creates a fresh one. `forget`
  // returns false when the cache no longer holds `promise`.
  async function withInstance(promise, use, forget) {
    const instance = await promise;
    try {
      return await use(instance);
    } catch (error) {
      if (!KEEP_INSTANCE.has(error?.name) && forget()) instance.destroy();
      throw error;
    }
  }

  const handlers = {
    async 'detector.prepare'() {
      await getDetector();
      return true;
    },
    async 'detector.detect'({ text }) {
      const promise = getDetector();
      const results = await withInstance(promise, (detector) => detector.detect(text), () => {
        if (detectorPromise !== promise) return false;
        detectorPromise = null;
        return true;
      });
      return results.slice(0, 3).map((r) => ({ lang: r.detectedLanguage, confidence: r.confidence }));
    },
    async 'translator.prepare'({ source, target }) {
      await getTranslator(source, target);
      return true;
    },
    async 'translator.translate'({ source, target, texts }) {
      const promise = getTranslator(source, target);
      const key = `${source}>${target}`;
      return withInstance(promise, async (translator) => {
        const out = [];
        for (const text of texts) out.push(await translator.translate(text));
        return out;
      }, () => translatorPromises.get(key) === promise && translatorPromises.delete(key));
    },
  };

  window.addEventListener('ght:req', (event) => {
    let request;
    try {
      request = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!Object.hasOwn(handlers, request.op)) return;
    handlers[request.op](request.args ?? {}).then(
      (result) => emit('ght:res', { id: request.id, result }),
      (error) => emit('ght:res', {
        id: request.id,
        error: error?.message || String(error),
        code: error?.name === 'NotAllowedError' ? 'activation' : error?.name,
      }),
    );
  });
})();
