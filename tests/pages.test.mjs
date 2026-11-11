import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageOf } from '../src/pages.js';

test('route classification covers content pages and rejects editors and unrelated GitHub tools', () => {
  const examples = {
    '/': 'home', '/dashboard': 'home', '/feed': 'feed', '/dashboard-feed': 'feed',
    '/issues': 'lists', '/pulls': 'lists', '/issues/assigned': 'lists',
    '/owner/repo/issues': 'lists', '/owner/repo/pulls/': 'lists', '/owner/repo/issues/42': 'issue',
    '/owner/repo/pull/42/files': 'pull', '/owner/repo/pull/42/commits': 'pull',
    '/owner/repo/releases': 'releases', '/owner/repo/releases/latest': 'releases',
    '/owner/repo/releases/tag/release/v1.2.3': 'releases',
    '/owner/repo/discussions': 'discussionList', '/owner/repo/discussions/categories/q-a': 'discussionList',
    '/owner/repo/discussions/42': 'discussion', '/owner/repo/compare/main...feature': 'compare',
    '/owner/repo/wiki': 'wiki', '/owner/repo/wiki/Getting-Started': 'wiki',
    '/owner/repo': 'repo', '/owner/repo/tree/main/docs': 'repo', '/owner/repo/blob/main/README.md': 'repo',
    '/owner/repo/commit/abcd1234': 'commit', '/owner/repo/commits/main': 'commits',
  };
  for (const [path, kind] of Object.entries(examples)) assert.equal(pageOf(path)?.kind, kind, path);
  for (const path of ['/owner/repo/issues/new', '/owner/repo/discussions/new', '/owner/repo/releases/new', '/owner/repo/releases/edit/v1', '/owner/repo/wiki/_new', '/owner/repo/wiki/FAQ/_edit', '/owner/repo/wiki/FAQ/_history', '/owner/repo/actions', '/owner/repo/settings', '/login']) {
    assert.equal(pageOf(path), null, path);
  }
  assert.equal(pageOf('/owner/repo/pull/42').key, pageOf('/owner/repo/pull/42/files').key);
});
