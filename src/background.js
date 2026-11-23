// Network translation providers will send their requests from here: content scripts are bound
// by github.com's CORS rules. See providers/index.js.

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message !== 'get-translation-shortcut') return;
  chrome.commands.getAll().then(commands => {
    reply(commands.find(command => command.name === 'toggle-translation')?.shortcut ?? '');
  }, () => reply(''));
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-translation' || tab?.id == null) return;
  // Only supported GitHub tabs have a content script listening.
  chrome.tabs.sendMessage(tab.id, command, { frameId: 0 }).catch(() => {});
});
