export function pageOf(pathname) {
  if (/^\/(?:dashboard\/?|feed\/?|dashboard-feed\/?)?$/.test(pathname)) {
    return { key: pathname, kind: /feed/.test(pathname) ? 'feed' : 'home', always: false };
  }
  if (/^\/(?:issues|pulls)(?:\/(?:assigned|mentioned|created|review-requested))?\/?$/.test(pathname)) {
    return { key: pathname, kind: 'lists', always: true };
  }
  const repo = pathname.match(/^\/[^/]+\/[^/]+(?=\/|$)/)?.[0];
  if (!repo) return null;
  const suffix = pathname.slice(repo.length);
  const detail = suffix.match(/^\/(pull|issues|discussions)\/(\d+)(?=\/|$)/);
  if (detail) {
    const kind = { pull: 'pull', issues: 'issue', discussions: 'discussion' }[detail[1]];
    return { key: `${repo}/${detail[1]}/${detail[2]}`, kind, always: true };
  }
  if (/^\/(?:issues|pulls)\/?$/.test(suffix)) return { key: pathname, kind: 'lists', always: true };
  if (/^\/discussions(?:\/categories\/[^/]+)?\/?$/.test(suffix)) return { key: pathname, kind: 'discussionList', always: true };
  if (/^\/releases(?:\/(?:latest|tag\/.+))?\/?$/.test(suffix)) return { key: pathname, kind: 'releases', always: true };
  if (/^\/compare(?:\/.+)?\/?$/.test(suffix)) return { key: pathname, kind: 'compare', always: true };
  if (/^\/wiki(?:\/.+)?\/?$/.test(suffix) && !/\/(?:_new|_edit|_history|_compare)(?:\/|$)/.test(suffix)) {
    return { key: pathname, kind: 'wiki', always: true };
  }
  if (/^\/commit\/[0-9a-f]{7,40}\/?$/i.test(suffix)) return { key: pathname, kind: 'commit', always: true };
  if (/^\/commits(?:\/.*)?$/.test(suffix)) return { key: pathname, kind: 'commits', always: true };
  if (/^\/?$/.test(suffix) || /^\/(?:tree|blob)\/.+/.test(suffix)) return { key: pathname, kind: 'repo', always: false };
  return null;
}

export const PR_MAIN_TITLE = 'h1 .markdown-title, .gh-header-title .js-issue-title, [data-component="TitleArea"] h1 [class*="markdownTitle"]';
export const PR_TITLES = `${PR_MAIN_TITLE}, h2[class*="PageHeader-Title"] .markdown-title, [data-component="PH_Title"] [class*="markdownTitle"]`;
export const ISSUE_TITLE = '[data-testid="issue-title"], [data-testid="issue-title-sticky"], .gh-header-title .js-issue-title';
export const REFERENCED_COMMIT = '[class*="referencedCommitContainer"]';
export const DISCUSSION_TITLE = '.gh-header-title .js-issue-title, h1 .markdown-title';
export const LIST_TITLE = 'a[data-testid="issue-listitem-title-link"], a[data-testid="listitem-title-link"], .js-issue-row a.js-navigation-open';
export const DISCUSSION_LIST_TITLE = 'a.discussion-title, a.discussion-Link--secondary, a[data-testid="discussion-title"]';
export const RELEASE_TITLE = '[data-test-selector="release-title"], .release-title, .Box-body .f1 a[href*="/releases/tag/"], .Box-body > .d-flex h1';
export const WIKI_TITLE = '#wiki-wrapper .gh-header-title, .repository-content .gh-header-title';
export const FEED_CARD = '.feed-item, .dashboard-feed-item, [data-testid="feed-item"], [data-testid="feed-card"], [data-testid="event-card"], [data-testid="issue-card"], [class*="FeedCard"], [class*="feedCard"], [class*="FeedItem"], [class*="feedItem"], .news .body, main article, [role="main"] article, [role="article"]';

export function listScope(el) {
  return el.closest('[data-testid="issues-list-surface"], [data-testid="pull-request-list"], [data-testid="discussion-list"]')
    ?? el.closest('[data-listview-component="items-list"]')?.parentElement
    ?? el.closest('.js-navigation-container, .discussion-list')?.parentElement
    ?? document.querySelector('.repository-content, main, [role="main"]')
    ?? el.parentElement;
}

export function releaseScope(el) {
  return el.closest('[data-release-anchor], .release-entry, [data-testid="release-card"]')
    ?? el.closest('.Box:has([data-test-selector="body-content"])')
    ?? el.closest('.Box') ?? el.parentElement;
}

export function releaseTitles(root = document) {
  return [...root.querySelectorAll(RELEASE_TITLE)].filter(el =>
    !el.closest('[role="dialog"], dialog, .Overlay, include-fragment, [data-ght-clone], [data-ght-ui]'));
}

export function wikiScope(el) {
  return el.closest('#wiki-wrapper, .wiki-container') ?? document.querySelector('.repository-content, main') ?? el.parentElement;
}

export function feedContent() {
  const marker = document.querySelector('.news, #dashboard, .dashboard, [data-testid*="feed"], [data-target*="feed"], [data-testid="dashboard"]');
  if (!document.body.classList.contains('logged-in') && !marker) return [];
  const nodes = new Set();
  const cards = [...document.querySelectorAll(FEED_CARD)].filter(card => !card.closest('nav, aside, [role="navigation"], [data-ght-clone]'));
  for (const card of cards) {
    // Read rendered content, never identity controls, event counters or navigation.
    for (const node of card.querySelectorAll('.markdown-body, p, h2, h3, .repo-description, .repo-desc, [data-testid="repo-description"], .feed-event-title')) {
      if (node.closest('form, button, [role="button"], nav, aside, [data-ght-clone], [data-ght-ui]')) continue;
      if (!node.matches('.markdown-body') && node.querySelector('button, input, select, textarea, form, [role="button"]')) continue;
      if (node.parentElement.closest('.markdown-body') || node.querySelector('.markdown-body')) continue;
      if (node.matches('h2, h3') && !node.querySelector('a[href*="/issues/"], a[href*="/pull/"], a[href*="/discussions/"], a[href*="/releases/"], a[href*="/commit/"]')) continue;
      nodes.add(node);
    }
    for (const link of card.querySelectorAll('a[href]')) {
      if (!/\/(?:issues|pull|discussions)\/\d+(?:[?#]|$)|\/releases\/tag\/|\/commit\/[0-9a-f]{7,40}(?:[?#]|$)/i.test(link.getAttribute('href') ?? '')) continue;
      if (link.closest('.markdown-body, nav, aside, form, [data-ght-clone]') || [...nodes].some(node => node.contains(link))) continue;
      if (/^(?:#\d+|[\w.-]+\/[\w.-]+#\d+|[0-9a-f]{7,40})$/i.test(link.textContent.trim())) continue;
      nodes.add(link);
    }
  }
  return [...nodes];
}

export function extraTargets(kind) {
  if (kind === 'issue') return [{ mode: 'inline', kind: 'issues', selector: ISSUE_TITLE }];
  if (kind === 'discussion') return [{ mode: 'inline', kind: 'discussions', selector: DISCUSSION_TITLE }];
  if (kind === 'lists') return [{ mode: 'inline', kind: 'lists', selector: LIST_TITLE, allowInForm: true }];
  if (kind === 'discussionList') return [{ mode: 'inline', kind: 'discussions', selector: DISCUSSION_LIST_TITLE, allowInForm: true }];
  if (kind === 'releases') return [{ mode: 'inline', kind: 'releases', find: releaseTitles }];
  if (kind === 'wiki') return [{ mode: 'inline', kind: 'wiki', selector: WIKI_TITLE }];
  if (kind === 'home' || kind === 'feed') return [{ mode: 'block', kind: 'feed', find: feedContent }];
  if (kind === 'compare') return [
    { mode: 'inline', kind: 'commitTitles', find: () => [...document.querySelectorAll('.js-commits-list-item a.markdown-title, [data-testid="commit-row-item"] h4 > a > span')].filter(el => !el.closest('code, pre')) },
    { mode: 'plain', kind: 'commitBodies', selector: '.js-details-container .Details-content--hidden > pre, .extended-commit-description-container' },
  ];
  return [];
}
