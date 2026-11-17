import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

const bridge = await readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/page-bridge.js', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'client', platform: 'browser',
});
const client = bundled.outputFiles[0].text;
const flush = () => setImmediate();
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const namedError = (name) => Object.assign(new Error(name), { name });

function fixture({ installBridge = true, translate = async text => `translated ${text}`, detect, create } = {}) {
  const window = new EventTarget();
  const timers = new Map();
  const instances = [];
  const requests = [];
  let now = 0, sequence = 0;
  const emit = (type, payload) => window.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(payload) }));
  const context = vm.createContext({
    window, CustomEvent, AbortController, console,
    navigator: { languages: ['en'] },
    chrome: { i18n: {
      getUILanguage: () => 'en', getMessage: key => key,
      detectLanguage: async () => ({ isReliable: true, languages: [{ language: 'en', percentage: 100 }] }),
    } },
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  context.self = context;
  const make = async (kind, options) => {
    const instance = {
      kind, options, destroyed: false,
      translate: (text, options) => translate(text, options, instance),
      detect: (text, options) => detect ? detect(text, options, instance) : Promise.resolve([
        { detectedLanguage: 'en', confidence: 0.9 }, { detectedLanguage: 'und', confidence: 0.1 },
      ]),
    };
    options.signal.addEventListener('abort', () => { instance.destroyed = true; });
    instances.push(instance);
    return create ? create(instance) : instance;
  };
  context.Translator = { create: options => make('translator', options) };
  context.LanguageDetector = { create: options => make('detector', options) };
  window.addEventListener('ght:req', event => {
    try { requests.push(JSON.parse(event.detail)); } catch { /* Deliberately malformed test input. */ }
  });
  if (installBridge) vm.runInContext(bridge, context);
  vm.runInContext(client, context);
  const tick = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now && timers.delete(id)) timer.callback();
    }
  };
  return { window, context, timers, instances, requests, emit, tick, ...context.client };
}

const args = { source: 'en', target: 'ru', texts: ['Hello'] };

test('real bridge starts creation synchronously, reuses instances and returns ordered translations', async () => {
  const f = fixture();
  const prepared = f.callBridge('translator.prepare', args);
  assert.equal(f.instances.length, 1);
  await prepared;
  assert.deepEqual(Array.from(await f.callBridge('translator.translate', { ...args, texts: ['one', 'two'] })), ['translated one', 'translated two']);
  assert.equal(f.instances.length, 1);
  const detected = await f.callBridge('detector.detect', { text: 'Hello world' });
  assert.equal(detected[0].lang, 'en');
  assert.equal(f.timers.size, 0);
});

test('a silent bridge times out, ignores late replies and accepts a new request', async () => {
  const f = fixture({ installBridge: false });
  const call = f.callBridge('translator.translate', args);
  const rejected = assert.rejects(call, { code: 'TimeoutError', message: 'errorTimeout' });
  f.tick(120000);
  await rejected;
  f.emit('ght:res', { id: f.requests[0].id, result: ['too late'] });
  const next = f.callBridge('translator.translate', args);
  f.emit('ght:res', { id: f.requests[1].id, result: ['recovered'] });
  assert.equal((await next)[0], 'recovered');
  assert.equal(f.timers.size, 0);
});

test('timeout aborts a stalled translation, discards its instance and allows retry', async () => {
  const waiting = deferred();
  let signal;
  const f = fixture({ translate: (text, options, instance) => {
    if (instance === f.instances[0]) { signal = options.signal; return waiting.promise; }
    return Promise.resolve(`recovered ${text}`);
  } });
  const first = f.callBridge('translator.translate', args);
  const rejected = assert.rejects(first, { code: 'TimeoutError' });
  await flush();
  f.tick(120000);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(f.instances[0].destroyed, true);
  assert.equal((await f.callBridge('translator.translate', args))[0], 'recovered Hello');
  waiting.resolve('late');
  await flush();
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[1].destroyed, false);
  assert.equal(f.timers.size, 0);
});

test('a stalled create is aborted; its late rejection cannot evict a replacement', async () => {
  const waiting = deferred();
  const f = fixture({ create: instance => instance === f.instances[0] ? waiting.promise : instance });
  let progress;
  f.onDownloadProgress(value => { progress = value; });
  const first = f.callBridge('translator.prepare', args);
  f.emit('ght:progress', { loaded: 0.25 });
  const rejected = assert.rejects(first, { code: 'TimeoutError' });
  f.tick(120000);
  assert.equal(f.instances[0].options.signal.aborted, false);
  f.tick(13 * 60 * 1000);
  await rejected;
  assert.equal(progress, 1);
  assert.equal(f.instances[0].options.signal.aborted, true);
  await f.callBridge('translator.prepare', args);
  waiting.reject(namedError('AbortError'));
  await flush();
  await f.callBridge('translator.translate', args);
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[1].destroyed, false);
});

test('a stalled detector falls back to chrome.i18n and can be recreated', async () => {
  const f = fixture({ detect: () => new Promise(() => {}) });
  const detection = f.detectLanguage('This is an English sentence');
  await flush();
  f.tick(15000);
  assert.equal((await detection).lang, 'en');
  assert.equal(f.instances[0].destroyed, true);
  await f.callBridge('detector.prepare');
  assert.equal(f.instances.length, 2);
  assert.equal(f.timers.size, 0);
});

test('fatal translator and detector failures drop their cached instances', async () => {
  for (const kind of ['translator', 'detector']) {
    let fail = true;
    const use = async () => { if (fail) throw namedError('OperationError'); return kind === 'translator' ? 'ok' : []; };
    const f = fixture({ [kind === 'translator' ? 'translate' : 'detect']: use });
    const op = kind === 'translator' ? 'translator.translate' : 'detector.detect';
    await assert.rejects(f.callBridge(op, { ...args, text: 'Hello' }), { code: 'OperationError' });
    assert.equal(f.instances[0].destroyed, true);
    fail = false;
    await f.callBridge(op, { ...args, text: 'Hello' });
    assert.equal(f.instances.length, 2);
  }
});

test('activation, input quota and ordinary abort errors preserve a usable instance', async () => {
  for (const name of ['NotAllowedError', 'QuotaExceededError', 'AbortError']) {
    let fail = true;
    const f = fixture({ translate: async () => { if (fail) throw namedError(name); return 'ok'; } });
    await assert.rejects(f.callBridge('translator.translate', args), { code: name === 'NotAllowedError' ? 'activation' : name });
    fail = false;
    await f.callBridge('translator.translate', args);
    assert.equal(f.instances.length, 1);
    assert.equal(f.instances[0].destroyed, false);
  }
});

test('long multi-segment translation remains alive while segments finish', async () => {
  const segments = [deferred(), deferred()];
  let calls = 0;
  const f = fixture({ translate: () => segments[calls++].promise });
  const translation = f.callBridge('translator.translate', { ...args, texts: ['one', 'two'] });
  await flush();
  f.tick(100000);
  segments[0].resolve('first');
  await flush();
  f.tick(100000);
  assert.equal(f.instances[0].destroyed, false);
  segments[1].resolve('second');
  assert.deepEqual(Array.from(await translation), ['first', 'second']);
  assert.equal(f.timers.size, 0);
});

test('malformed events are ignored and unsupported APIs report localized errors', async () => {
  const f = fixture();
  let progress = null;
  f.onDownloadProgress(value => { progress = value; });
  for (const type of ['ght:req', 'ght:res', 'ght:progress', 'ght:activity', 'ght:cancel']) {
    for (const detail of ['{', 'null', '42']) f.window.dispatchEvent(new CustomEvent(type, { detail }));
  }
  f.emit('ght:req', { id: 500, op: 'toString' });
  f.emit('ght:progress', { loaded: 2 });
  assert.equal(progress, null);
  f.emit('ght:progress', { loaded: 0.5 });
  assert.equal(progress, 0.5);
  delete f.context.Translator;
  await assert.rejects(f.callBridge('translator.translate', args), { code: 'Unsupported', message: 'errorUnsupported' });
  assert.equal(f.timers.size, 0);
});


test('caller cancellation aborts the engine, clears timers and ignores late replies', async () => {
  const waiting = deferred();
  const f = fixture({ translate: () => waiting.promise });
  const controller = new AbortController();
  const call = f.callBridge('translator.translate', args, { signal: controller.signal });
  const rejected = assert.rejects(call, { name: 'AbortError' });
  await flush();
  controller.abort();
  await rejected;
  assert.equal(f.instances[0].destroyed, true);
  assert.equal(f.timers.size, 0);
  waiting.resolve('late');
  await flush();
  assert.equal(f.timers.size, 0);
  await f.callBridge('translator.prepare', args);
  assert.equal(f.instances.length, 2);
});

test('an already cancelled call does not dispatch or create timers', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.callBridge('translator.translate', args, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
});

test('cancelled detection does not fall back to another detector', async () => {
  const f = fixture({ detect: () => new Promise(() => {}) });
  let fallbackCalls = 0;
  f.context.chrome.i18n.detectLanguage = async () => { fallbackCalls++; return { languages: [] }; };
  const controller = new AbortController();
  const detected = f.detectLanguage('Hello world', { signal: controller.signal });
  const rejected = assert.rejects(detected, { name: 'AbortError' });
  await flush();
  controller.abort();
  await rejected;
  assert.equal(fallbackCalls, 0);
  assert.equal(f.timers.size, 0);
});
