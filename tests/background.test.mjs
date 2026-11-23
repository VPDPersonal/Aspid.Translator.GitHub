import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');

test('translation shortcut falls back to the active tab when the browser omits the tab', async () => {
  const queries = [];
  const messages = [];
  let handleCommand;
  let activeTabs = [{ id: 7 }];
  runInNewContext(source, { chrome: {
    action: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener: callback => { handleCommand = callback; } } },
    tabs: {
      query: async ({ active, lastFocusedWindow }) => {
        queries.push({ active, lastFocusedWindow });
        return activeTabs;
      },
      sendMessage: async (id, command, { frameId }) => { messages.push({ id, command, frameId }); },
    },
  } });

  const command = 'toggle-translation';
  await handleCommand(command, { id: 3 });
  assert.deepEqual(queries, []);
  await handleCommand(command);
  assert.deepEqual(queries, [{ active: true, lastFocusedWindow: true }]);
  activeTabs = [];
  await handleCommand(command);
  await handleCommand('other-command', { id: 3 });
  assert.deepEqual(messages, [
    { id: 3, command, frameId: 0 },
    { id: 7, command, frameId: 0 },
  ]);
});
