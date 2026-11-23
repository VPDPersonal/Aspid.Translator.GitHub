// Network translation providers will send their requests from here: content scripts are bound
// by github.com's CORS rules. See providers/index.js.

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-translation') return;
  // Some browsers dispatch commands without the optional tab argument.
  const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (tabId == null) return;
  // Only supported GitHub tabs have a content script listening.
  await chrome.tabs.sendMessage(tabId, command, { frameId: 0 }).catch(() => {});
});
