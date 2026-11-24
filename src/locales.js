// Chrome's locale folders for targets that have no folder of their own name.
const FOLDERS = { zh: 'zh_CN', 'zh-Hant': 'zh_TW', pt: 'pt_BR' };

/** Returns the parsed messages.json for target language `code`, or null when the extension has none. */
export async function loadMessages(code) {
  const folder = FOLDERS[code] ?? code;
  try {
    const response = await fetch(chrome.runtime.getURL(`_locales/${folder}/messages.json`));
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
