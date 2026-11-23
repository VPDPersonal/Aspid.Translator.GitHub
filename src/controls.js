import { DISCUSSION_TITLE, FEED_CARD, ISSUE_TITLE, PR_MAIN_TITLE, REFERENCED_COMMIT, listScope, pageOf, releaseScope, releaseTitles, wikiScope } from './pages.js';

const COMMENT = '.js-comment, .timeline-comment, .review-comment, .discussion-comment, .react-issue-body, [id^="discussion_r"], [data-testid="issue-body"], [data-testid="issue-comment"], [data-testid="comment-viewer-outer-box"], [data-testid="comment-viewer-container"], [class*="ReviewComment"]';
const REACTIONS = '.comment-reactions, .js-reactions-container, [data-testid="reactions"], [role="toolbar"][aria-label="Reactions"]';
const COMMIT = `${REFERENCED_COMMIT}, [data-testid="commit-row-item"], .js-details-container, [class*="commitMessageContainer"]`;
const DIRECTORY_TABLE = 'table[aria-labelledby="folders-and-files"], table:has(.react-directory-row)';
const COMMIT_LINK = /\/commit\/[0-9a-f]{7,40}(?:[?#/]|$)/i;
export const ABOUT_SELECTOR = '[class*="sidebarSection"] > p[class*="description"], .BorderGrid-cell > p.f4.my-3';

function directoryHeader(table) {
  for (let parent = table.parentElement, depth = 0; parent && parent !== document.body && depth < 4; parent = parent.parentElement, depth++) {
    for (const child of parent.children) {
      if (!child.contains(table) && child.querySelector('[data-testid="latest-commit-details"], .octicon-history')) return child;
    }
  }
  return null;
}

function isCommitMessage(el) {
  const text = el.textContent.trim();
  return COMMIT_LINK.test(el.getAttribute('href') ?? '') && text && !/^[0-9a-f]{7,40}$/i.test(text)
    && !el.closest('[data-ght-clone], [data-ght-ui], [data-testid="latest-commit-details"]');
}

export function directoryMessages() {
  const messages = [];
  for (const table of document.querySelectorAll(DIRECTORY_TABLE)) {
    messages.push(...[...table.querySelectorAll('.react-directory-row-commit-cell a[href]')].filter(isCommitMessage));
    const header = directoryHeader(table);
    if (header) messages.push(...[...header.querySelectorAll('a[href]')].filter(isCommitMessage));
  }
  return messages;
}

function directoryTable(el) {
  if (!el.matches('a[href]')) return null;
  const table = el.closest(DIRECTORY_TABLE);
  if (table) return table;
  for (const candidate of document.querySelectorAll(DIRECTORY_TABLE)) {
    if (directoryHeader(candidate)?.contains(el)) return candidate;
  }
  return null;
}

function directoryPosition(table) {
  const header = directoryHeader(table);
  if (!header) return null;
  const links = [...header.querySelectorAll('a[href*="/commits/"]')];
  if (!links.length) return { parent: header };
  // Desktop and mobile history links may live in different visibility wrappers.
  let parent = links[0].parentElement;
  while (parent !== header && (!links.every(link => parent.contains(link)) || getComputedStyle(parent).display === 'none')) {
    parent = parent.parentElement;
  }
  return { parent };
}

export function controlScope(el, kind) {
  const pageKind = pageOf(location.pathname)?.kind;
  if (kind === 'discussions' && pageKind === 'discussionList') {
    return { root: document.querySelector('.repository-content, main, [role="main"]') ?? listScope(el), kind: 'collection', local: false };
  }
  if (kind === 'lists') return { root: listScope(el), kind: 'collection', local: false };
  if (kind === 'releases') return { root: releaseScope(el), kind: 'release' };
  if (kind === 'wiki') return { root: wikiScope(el), kind: 'wiki', local: false };
  if (kind === 'feed') return { root: el.closest(FEED_CARD) ?? el.parentElement, kind: 'feedcard' };
  if ((kind === 'issues' && el.matches(ISSUE_TITLE)) || (kind === 'discussions' && el.matches(DISCUSSION_TITLE))) {
    const title = kind === 'issues'
      ? document.querySelector('[data-testid="issue-title"], h1 .js-issue-title') ?? el
      : document.querySelector('h1 .js-issue-title, h1 .markdown-title') ?? el;
    return { root: title.closest('h1, h2') ?? title.parentElement, kind: 'title', titleKind: pageKind };
  }
  if (kind === 'commitTitles' || kind === 'commitBodies') {
    const table = kind === 'commitTitles' && directoryTable(el);
    if (table) return { root: table, kind: 'directory' };
    return { root: el.closest(COMMIT) ?? el.parentElement, kind: 'commit' };
  }
  if (kind === 'prTitle') {
    // The normal and sticky headings represent the same title and share one switch.
    const title = document.querySelector(PR_MAIN_TITLE) ?? el;
    const heading = title.closest('h1, h2, .gh-header-title') ?? title.parentElement;
    return { root: heading.closest('[class*="titleWithAction"]') ?? heading, kind: 'title', titleKind: 'pull' };
  }
  if (kind === 'readme') return { root: el, kind: 'document' };
  if (kind === 'about') return { root: el.closest('[class*="sidebarSection"], .BorderGrid-cell') ?? el.parentElement, kind: 'about' };
  return { root: el.closest(COMMENT) ?? el.parentElement, kind: 'comment' };
}

function branch(node, parent) {
  while (node?.parentElement && node.parentElement !== parent) node = node.parentElement;
  return node?.parentElement === parent ? node : null;
}

function documentHeader(el) {
  const blob = el.closest('[class*="blobContainer"], .file');
  const actions = blob?.querySelector('.react-blob-header-edit-and-raw-actions');
  if (actions) return { parent: actions.parentElement, before: actions };
  const classic = el.closest('#readme')?.querySelector('.Box-header');
  if (classic) return { parent: classic };
  // Repository tabs and their actions are siblings of the rendered README.
  for (let parent = el.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth++) {
    for (const child of parent.children) {
      if (child.contains(el) || !child.querySelector('nav .octicon-book')) continue;
      const before = child.querySelector('[class*="readmeHeaderSlot"]')
        ?? child.querySelector('.octicon-list-unordered')?.closest('button');
      return { parent: child, before: before && branch(before, child) };
    }
  }
  return null;
}

function commitPosition(root, el) {
  if (root.matches(REFERENCED_COMMIT)) {
    const actions = root.querySelector('[class*="commitActions"]');
    return {
      parent: actions ?? root.querySelector('[class*="commitHeaderRow"]') ?? root,
      before: actions?.firstChild,
      headerControl: true,
      referenceControl: true,
    };
  }
  if (root.matches('[class*="commitMessageContainer"]')) {
    const header = [...document.querySelectorAll('[data-component="PageHeader"]')]
      .find(node => node.querySelector('a[class*="browseFilesButton"], a[href*="/tree/"] .octicon-file-code'));
    if (header) return { ...titlePosition(header), headerControl: true };
    // Keep a footer until the commit's action bar has rendered.
    return { parent: root.parentElement, before: root.nextSibling, footer: true };
  }
  if (root.matches('[data-testid="commit-row-item"]')) {
    const actions = root.querySelector('[data-testid="commit-row-browse-repo"]');
    const metadata = actions && branch(actions, root);
    if (metadata) return { parent: metadata, before: metadata.firstChild };
  }
  if (root.matches('.js-details-container')) {
    const row = root.closest('.js-commits-list-item');
    if (row) {
      const actions = row.querySelector(':scope > .flex-shrink-0');
      return actions
        ? { parent: actions, before: actions.firstChild, headerControl: true, compareControl: true }
        : { parent: row, before: root.nextSibling, headerControl: true, compareControl: true };
    }
    const title = root.querySelector('code:has(> a.markdown-title)');
    const line = title?.parentElement.parentElement;
    if (line) return { parent: line, before: title.parentElement.nextSibling };
  }
  const title = root.querySelector('h1, h2, h4') ?? el;
  // Keep the control outside text that is hidden when showing a translated copy.
  return { parent: title.parentElement, before: title.nextSibling };
}

function titlePosition(root, titleKind) {
  if (titleKind === 'discussion') {
    const number = root.querySelector('[class*="issueNumberText"], .gh-header-number');
    return { parent: number ?? root, compact: true, inlineTitle: true };
  }
  const header = root.closest('[data-component="PageHeader"]');
  const actions = header?.querySelector(':scope > [data-component="PH_Actions"]')
    ?? root.closest('.gh-header')?.querySelector('.gh-header-actions');
  if (titleKind === 'issue') {
    // GitHub renders separate action rows for the regular and narrow layouts.
    const context = header?.querySelector('[data-component="PageHeader.ContextAreaActions"]');
    const visible = [actions, context].find(row => row?.getClientRects().length);
    if (visible) {
      const parent = visible.querySelector('[class*="menuActionsContainer"]') ?? visible;
      const createIssue = parent.querySelector('a[href*="/issues/new"], [data-testid="new-issue-button"]');
      return { parent, before: (createIssue && branch(createIssue, parent)) ?? parent.firstChild };
    }
  }
  if (actions && !actions.hidden && getComputedStyle(actions).display !== 'none') {
    if (titleKind === 'pull') {
      const overview = [...actions.querySelectorAll(':is(a, button):not([data-ght-ui] *)')].find(node =>
        node.matches('a[href*="/pull/"][href*="/overview"]') || node.textContent.includes('Try the Overview page'));
      if (overview) return { parent: actions, before: branch(overview, actions).nextSibling };
    }
    return { parent: actions, before: actions.firstChild };
  }
  // GitHub renders an empty, hidden actions area before its controls load.
  // Use the same grid area without exposing or changing GitHub's hidden controls.
  if (header) return { parent: header, before: actions, titleStandalone: true };
  if (titleKind === 'issue') {
    const number = root.querySelector('[class*="issueNumberText"], .gh-header-number');
    return { parent: number ?? root, inlineTitle: true };
  }
  return { parent: root };
}

function position(group) {
  const el = [...group.jobs][0]?.el;
  if (!el) return null;
  if (group.kind === 'directory') return directoryPosition(group.root);
  if (group.kind === 'release') {
    const title = releaseTitles(group.root)[0];
    const body = title?.closest('.Box-body');
    const header = body && branch(title, body);
    if (header && header !== title) {
      const action = [...header.querySelectorAll('button, summary')]
        .find(node => !node.closest('dialog, [role="dialog"], [data-ght-ui]'));
      const container = action && branch(action, header);
      // Keep the toggle beside Compare, outside its custom element and dialog.
      const parent = container && container !== action && !container.matches('select-panel, dialog-helper, details') ? container : header;
      return { parent, before: action && branch(action, parent), compact: true, headerControl: true, releaseControl: true };
    }
  }
  if (group.kind === 'feedcard') {
    const actions = group.root.querySelector('.feed-actions, [data-testid="feed-actions"]');
    return { parent: group.root, before: actions && branch(actions, group.root), footer: true };
  }
  if (group.kind === 'title') return titlePosition(group.root, group.titleKind);
  if (group.kind === 'commit') return { ...commitPosition(group.root, el), compact: true };
  if (group.kind === 'about') {
    const heading = group.root.querySelector('h2');
    const action = heading?.querySelector(':is(button, a):not([data-ght-ui] *)');
    if (heading) return { parent: action?.parentElement ?? heading, before: action };
  }
  if (group.kind === 'document') {
    const header = documentHeader(el);
    if (header) return header;
  }
  if (group.kind === 'comment') {
    const reactions = [...group.root.querySelectorAll(REACTIONS)]
      .find(node => !node.closest('form, [data-ght-clone], .markdown-body') && node.closest(COMMENT) === group.root);
    if (reactions) return { parent: reactions };
  }
  // Older comment layouts and documents without a toolbar use a quiet footer.
  const anchor = el.tagName === 'TD' ? el.closest('table') ?? el : el;
  let before = anchor.nextSibling;
  while (before?.nodeType === 1 && before.hasAttribute('data-ght-clone')) before = before.nextSibling;
  return { parent: anchor.parentElement, before, footer: true, compact: group.kind !== 'comment' };
}

export function createControl(onClick) {
  const slot = document.createElement('span');
  slot.className = 'ght-control-slot';
  slot.setAttribute('data-ght-ui', '');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ght-toggle';
  const label = document.createElement('span');
  label.className = 'ght-toggle-text';
  button.append(label);
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  slot.append(button);
  return { slot, button, label };
}

export function placeControl(group) {
  const target = position(group);
  if (!target?.parent?.isConnected) return;
  const { slot, button } = group.control;
  const iconOnly = !target.footer && (['directory', 'about', 'document', 'comment'].includes(group.kind)
    || group.kind === 'title' && group.titleKind !== 'discussion');
  slot.classList.toggle('ght-control-footer', Boolean(target.footer));
  slot.classList.toggle('ght-control-icon', iconOnly);
  slot.classList.toggle('ght-control-title', group.kind === 'title');
  slot.classList.toggle('ght-control-title-inline', Boolean(target.inlineTitle));
  slot.classList.toggle('ght-control-title-standalone', Boolean(target.titleStandalone));
  slot.classList.toggle('ght-control-header', group.kind === 'title' || group.kind === 'about' || Boolean(target.headerControl));
  slot.classList.toggle('ght-control-about', group.kind === 'about');
  slot.classList.toggle('ght-control-release', Boolean(target.releaseControl));
  slot.classList.toggle('ght-control-compare', Boolean(target.compareControl));
  slot.classList.toggle('ght-control-reference', Boolean(target.referenceControl));
  button.classList.toggle('ght-toggle-compact', Boolean(target.compact));
  const before = target.before ?? null;
  // Avoid observing our own no-op placements as GitHub content changes.
  if (slot.parentNode !== target.parent || (before !== slot && slot.nextSibling !== before)) {
    target.parent.insertBefore(slot, before);
  }
  if (group.kind === 'document') {
    const el = [...group.jobs][0].el;
    const preview = el.closest('[class*="blobContainer"]')?.querySelector('[data-text="Preview"]')?.closest('button');
    const inactive = preview && preview.getAttribute('aria-pressed') === 'false';
    let hidden = Boolean(inactive);
    for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.hidden || parent.getAttribute('aria-hidden') === 'true' || getComputedStyle(parent).display === 'none') {
        hidden = true;
        break;
      }
    }
    slot.hidden = hidden;
  }
}

export function removeControl(group) {
  group.control?.slot.remove();
  group.control = null;
}
