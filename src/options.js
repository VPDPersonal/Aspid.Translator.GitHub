import { localizePage, t, uiLanguage, useMessages } from './i18n.js';
import { loadMessages } from './locales.js';
import { DEFAULT_SETTINGS, PARTS, TARGETS, languageName, loadSettings, saveSettings } from './settings.js';
import { PROVIDERS, getProvider } from './providers/index.js';

const $ = (id) => document.getElementById(id);
const form = $('form');
const partSwitch = (key) => form.querySelector(`[data-part="${key}"]`);
const autoSetting = $('auto').closest('.auto-setting');
let hideToast;

for (const event of ['pointerenter', 'focusin']) {
  autoSetting.addEventListener(event, () => autoSetting.classList.remove('dismissed'));
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') autoSetting.classList.add('dismissed');
});

function readForm() {
  return {
    provider: form.querySelector('input[name="provider"]:checked')?.value ?? DEFAULT_SETTINGS.provider,
    target: $('target').value,
    auto: $('auto').checked,
    parts: Object.fromEntries(PARTS.map((key) => [key, partSwitch(key).checked])),
  };
}

function showCount() {
  const number = new Intl.NumberFormat(uiLanguage());
  for (const group of form.querySelectorAll('details')) {
    const selected = group.querySelectorAll('[data-part]:checked').length;
    const total = group.querySelectorAll('[data-part]').length;
    const count = group.querySelector('.group-count');
    count.textContent = `${number.format(selected)} / ${number.format(total)}`;
    count.title = t('settingsPartsCount', selected, total);
  }
  const on = PARTS.filter((key) => partSwitch(key).checked).length;
  $('count').textContent = t('settingsPartsCount', on, PARTS.length);
}

function showSaved() {
  clearTimeout(hideToast);
  $('toast-text').textContent = t('settingsSaved');
  $('toast').classList.add('shown');
  hideToast = setTimeout(() => $('toast').classList.remove('shown'), 3000);
}

function renderProviders(selected) {
  const template = $('provider-row').content.firstElementChild;
  $('providers').replaceChildren();
  for (const provider of PROVIDERS) {
    const row = template.cloneNode(true);
    const input = row.querySelector('input');
    input.value = provider.id;
    input.checked = provider.id === selected;
    input.hidden = PROVIDERS.length === 1; // nothing to choose from yet
    row.querySelector('.name').textContent = provider.title;
    $('providers').append(row);
  }
}

// Each language in the page's language, with its own name after it, so that a page switched
// to a language the user does not read still shows the way back.
function renderTargets(selected) {
  const capitalize = (name, locale) => name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  const targets = TARGETS.map((code) => {
    const name = capitalize(languageName(code), uiLanguage());
    const own = capitalize(languageName(code, code), code);
    return { code, name, label: name === own ? name : `${name} — ${own}` };
  }).sort((a, b) => a.name.localeCompare(b.name, uiLanguage()));
  $('target').replaceChildren(...targets.map(({ code, label }) => new Option(label, code)));
  $('target').value = selected;
}

// Arabic and Hebrew read right to left; the page's CSS uses logical properties, so `dir` mirrors it.
function textDirection(language) {
  const locale = new Intl.Locale(language);
  return (locale.getTextInfo?.() ?? locale.textInfo)?.direction ?? 'ltr';
}

let shownTarget;

// The page speaks the target language when the extension has its strings, the browser's otherwise.
async function showLanguage(target) {
  shownTarget = target;
  const messages = await loadMessages(target);
  if (shownTarget !== target) return; // another language was picked meanwhile
  useMessages(messages, target);
  document.documentElement.lang = uiLanguage();
  document.documentElement.dir = textDirection(uiLanguage());
  document.title = t('settingsTitle');
  localizePage();
  renderTargets(target);
  renderProviders(form.querySelector('input[name="provider"]:checked')?.value);
  showCount();
  await showShortcut();
}

async function showShortcut() {
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find(command => command.name === 'toggle-translation')?.shortcut;
  $('shortcut').textContent = shortcut || t('shortcutUnassigned');
  $('shortcut').dir = shortcut ? 'ltr' : 'auto';
  const edit = $('edit-shortcut');
  edit.title = t('shortcutEdit');
  edit.setAttribute('aria-label', [t('shortcutLabel'), $('shortcut').textContent, edit.title].join(', '));
}

$('edit-shortcut').addEventListener('click', event => {
  event.preventDefault();
  chrome.tabs.create({ url: event.currentTarget.href });
});
window.addEventListener('focus', showShortcut);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) showShortcut();
});

async function init() {
  const settings = await loadSettings();
  $('auto').checked = settings.auto;
  for (const key of PARTS) partSwitch(key).checked = settings.parts[key];
  renderProviders(getProvider(settings.provider).id);
  await showLanguage(settings.target);
  form.inert = false;
}

// Every change is saved at once: open GitHub tabs listen to chrome.storage and apply it.
form.addEventListener('change', async (event) => {
  const settings = readForm();
  const update = event.target === $('target') ? showLanguage(settings.target) : showCount();
  await Promise.all([saveSettings(settings), update]);
  showSaved();
});
form.addEventListener('submit', (event) => event.preventDefault());

init();
