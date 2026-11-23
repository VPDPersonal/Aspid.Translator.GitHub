// Network translation providers will send their requests from here: content scripts are bound
// by github.com's CORS rules. See providers/index.js.

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-translation' || tab?.id == null) return;
  // Only supported GitHub tabs have a content script listening.
  chrome.tabs.sendMessage(tab.id, command, { frameId: 0 }).catch(() => {});
});
