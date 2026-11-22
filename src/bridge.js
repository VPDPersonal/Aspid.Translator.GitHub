// Runs in the page's MAIN world, where Chrome exposes the on-device Translator and
// LanguageDetector APIs. The isolated content script talks to it through window events
// with JSON string payloads.
(() => {
  if (window.__ghtBridge) return;
  window.__ghtBridge = true;

  let detector = null;
  const translators = new Map();
  const requests = new Map();
  const emit = (type, payload) =>
    window.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(payload) }));
  const monitor = (m) =>
    m.addEventListener('downloadprogress', (event) => emit('ght:progress', { loaded: event.loaded }));

  function unsupported(api) {
    const error = new Error(`${api} API is not available in this browser: it needs desktop Chrome 138 or newer.`);
    error.name = 'Unsupported';
    return error;
  }

  // Each cached instance owns its creation signal, so cancellation can stop a hung create()
  // and destroy a ready instance without affecting a newer replacement in the cache.
  function entry(create, forget) {
    const controller = new AbortController();
    const value = { controller, promise: null, users: new Set() };
    value.promise = create(controller.signal).catch((error) => {
      forget(value);
      throw error;
    });
    return value;
  }

  function forgetDetector(value) {
    if (detector !== value) return false;
    detector = null;
    return true;
  }

  function forgetTranslator(key, value) {
    if (translators.get(key) !== value) return false;
    return translators.delete(key);
  }

  // Start create() before the first await to preserve a click's user activation.
  function getDetector() {
    if (!('LanguageDetector' in self)) throw unsupported('Language Detector');
    return detector ??= entry((signal) => LanguageDetector.create({ monitor, signal }), forgetDetector);
  }

  function getTranslator(sourceLanguage, targetLanguage) {
    if (!('Translator' in self)) throw unsupported('Translator');
    const key = `${sourceLanguage}>${targetLanguage}`;
    if (!translators.has(key)) {
      translators.set(key, entry(
        (signal) => Translator.create({ sourceLanguage, targetLanguage, monitor, signal }),
        (value) => forgetTranslator(key, value),
      ));
    }
    return translators.get(key);
  }

  const KEEP_INSTANCE = new Set(['AbortError', 'NotAllowedError', 'QuotaExceededError']);

  async function withInstance(value, use, forget, signal) {
    const discard = () => {
      if (forget()) value.controller.abort();
    };
    value.users.add(signal);
    const cancel = () => {
      value.users.delete(signal);
      if (!value.users.size) discard();
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const instance = await value.promise;
      signal.throwIfAborted();
      return await use(instance);
    } catch (error) {
      if (!signal.aborted && !KEEP_INSTANCE.has(error?.name)) discard();
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      value.users.delete(signal);
    }
  }

  function useDetector(signal, use) {
    const value = getDetector();
    return withInstance(value, use, () => forgetDetector(value), signal);
  }

  function useTranslator({ source, target }, signal, use) {
    const value = getTranslator(source, target);
    return withInstance(value, use, () => forgetTranslator(`${source}>${target}`, value), signal);
  }

  const handlers = {
    'detector.prepare': (_, signal) => useDetector(signal, () => true),
    'detector.detect': ({ text }, signal) => useDetector(signal, async (instance) => {
      const results = await instance.detect(text, { signal });
      return results.slice(0, 3).map((r) => ({ lang: r.detectedLanguage, confidence: r.confidence }));
    }),
    'translator.prepare': (args, signal) => useTranslator(args, signal, () => true),
    'translator.translate': (args, signal, activity) => useTranslator(args, signal, async (instance) => {
      const out = [];
      for (const text of args.texts) {
        signal.throwIfAborted();
        out.push(await instance.translate(text, { signal }));
        activity(); // A large README can take time while still making progress.
      }
      return out;
    }),
  };

  function payload(event) {
    try {
      const value = JSON.parse(event.detail);
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  window.addEventListener('ght:cancel', (event) => {
    const request = payload(event);
    if (!request) return;
    const controller = requests.get(request.id);
    requests.delete(request.id);
    controller?.abort();
  });

  window.addEventListener('ght:req', (event) => {
    const request = payload(event);
    if (!request || !Number.isSafeInteger(request.id) || requests.has(request.id)
      || !Object.hasOwn(handlers, request.op)) return;
    const controller = new AbortController();
    requests.set(request.id, controller);
    // Calling the handler directly keeps user activation; Promise.resolve().then() would defer it.
    let result;
    try {
      result = handlers[request.op](request.args ?? {}, controller.signal,
        () => emit('ght:activity', { id: request.id }));
    } catch (error) {
      result = Promise.reject(error);
    }
    Promise.resolve(result).then(
      (result) => {
        if (!controller.signal.aborted) emit('ght:res', { id: request.id, result });
      },
      (error) => {
        if (!controller.signal.aborted) emit('ght:res', {
          id: request.id,
          error: error?.message || String(error),
          code: error?.name === 'NotAllowedError' ? 'activation' : error?.name,
        });
      },
    ).finally(() => {
      if (requests.get(request.id) === controller) requests.delete(request.id);
    });
  });
})();
