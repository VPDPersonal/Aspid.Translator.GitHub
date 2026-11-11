const COMMENT = '.js-comment, .timeline-comment, .review-comment, [id^="discussion_r"], [data-testid="comment-viewer-container"], [class*="ReviewComment"]';
const COMMIT = '[data-testid="commit-row-item"], .js-details-container, [class*="commitMessageContainer"]';
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
  if (!links.length) return { parent: header, compact: true };
  // Desktop and mobile history links may live in different visibility wrappers.
  let parent = links[0].parentElement;
  while (parent !== header && (!links.every(link => parent.contains(link)) || getComputedStyle(parent).display === 'none')) {
    parent = parent.parentElement;
  }
  return { parent, before: branch(links[0], parent), compact: true };
}

export function controlScope(el, kind) {
  if (kind === 'commitTitles' || kind === 'commitBodies') {
    const table = kind === 'commitTitles' && directoryTable(el);
    if (table) return { root: table, kind: 'directory' };
    return { root: el.closest(COMMIT) ?? el.parentElement, kind: 'commit' };
  }
  if (kind === 'prTitle') {
    // The normal and sticky headings represent the same title and share one switch.
    const title = document.querySelector('h1 .markdown-title, .gh-header-title .js-issue-title') ?? el;
    const heading = title.closest('h1, h2, .gh-header-title') ?? title.parentElement;
    return { root: heading.closest('[class*="titleWithAction"]') ?? heading, kind: 'title' };
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
  if (actions) return { parent: actions.parentElement, before: actions, compact: true };
  const classic = el.closest('#readme')?.querySelector('.Box-header');
  if (classic) return { parent: classic, compact: false };
  // Repository tabs and their actions are siblings of the rendered README.
  for (let parent = el.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth++) {
    for (const child of parent.children) {
      if (child.contains(el) || !child.querySelector('nav .octicon-book')) continue;
      const before = child.querySelector('[class*="readmeHeaderSlot"]')
        ?? child.querySelector('.octicon-list-unordered')?.closest('button');
      return { parent: child, before: before && branch(before, child), compact: false };
    }
  }
  return null;
}

function commitPosition(root, el) {
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
    const title = root.querySelector('code:has(> a.markdown-title)');
    const line = title?.parentElement.parentElement;
    if (line) return { parent: line, before: title.parentElement.nextSibling };
  }
  const title = root.querySelector('h1, h2, h4') ?? el;
  // Keep the control outside text that is hidden when showing a translated copy.
  return { parent: title.parentElement, before: title.nextSibling };
}

function titlePosition(root) {
  const header = root.closest('[data-component="PageHeader"]');
  const actions = header?.querySelector(':scope > [data-component="PH_Actions"]')
    ?? root.closest('.gh-header')?.querySelector('.gh-header-actions');
  if (actions && !actions.hidden && getComputedStyle(actions).display !== 'none') {
    return { parent: actions, before: actions.firstChild, compact: true };
  }
  // GitHub renders an empty, hidden actions area before its controls load.
  // Use the same grid area without exposing or changing GitHub's hidden controls.
  if (header) return { parent: header, before: actions, compact: true, titleStandalone: true };
  return { parent: root, compact: true };
}

function position(group) {
  const el = [...group.jobs][0]?.el;
  if (!el) return null;
  if (group.kind === 'directory') return directoryPosition(group.root);
  if (group.kind === 'title') return titlePosition(group.root);
  if (group.kind === 'commit') return { ...commitPosition(group.root, el), compact: true };
  if (group.kind === 'about') {
    const heading = group.root.querySelector('h2');
    const action = heading?.querySelector('button, a');
    if (heading) return { parent: heading, before: action && branch(action, heading), compact: true };
  }
  if (group.kind === 'document') {
    const header = documentHeader(el);
    if (header) return header;
  }
  if (group.kind === 'comment') {
    const reactions = group.root.querySelector('.comment-reactions')
      ?? [...group.root.querySelectorAll('.js-reactions-container, [data-testid="reactions"]')]
        .find(node => !node.closest('form, [data-ght-clone], .markdown-body'));
    if (reactions && !reactions.closest('form, [data-ght-clone], .markdown-body')) {
      return { parent: reactions, compact: false };
    }
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
  const icon = document.createElement('span');
  icon.className = 'ght-toggle-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '🌐';
  const label = document.createElement('span');
  label.className = 'ght-toggle-text';
  button.append(icon, label);
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  slot.append(button);
  return { slot, button, icon, label };
}

export function placeControl(group) {
  const target = position(group);
  if (!target?.parent?.isConnected) return;
  const { slot, button } = group.control;
  slot.classList.toggle('ght-control-footer', Boolean(target.footer));
  slot.classList.toggle('ght-control-document', group.kind === 'document');
  slot.classList.toggle('ght-control-title', group.kind === 'title');
  slot.classList.toggle('ght-control-title-standalone', Boolean(target.titleStandalone));
  slot.classList.toggle('ght-control-header', group.kind === 'title' || group.kind === 'about' || Boolean(target.headerControl));
  slot.classList.toggle('ght-control-about', group.kind === 'about');
  button.classList.toggle('ght-toggle-compact', Boolean(target.compact));
  const before = target.before ?? null;
  // Avoid observing our own no-op placements as GitHub content changes.
  if (slot.parentNode !== target.parent || (before && before !== slot && slot.nextSibling !== before)) {
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
