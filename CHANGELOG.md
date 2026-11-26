# Changelog

This file records notable changes to **Aspid.Translator.GitHub**.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

Initial release. Requires desktop Google Chrome **138** or newer.

### Added

- **Pull requests, issues and discussions.** Read translated titles, descriptions, conversations
  and code review comments in place. Titles in issue, pull request and discussion lists are translated too.
- **Commits and repository content.** Translate commit titles and descriptions in commit lists,
  on commit and comparison pages, and in pull request timelines. Translation also covers repository
  descriptions, READMEs, rendered Markdown files, release notes, wiki pages and signed-in Home and Feed cards.
- **Translation controls.** Choose from 39 target languages, translate automatically or on demand,
  and turn translation on or off for individual types of content.
- **Access to the original.** Use **Show original** beside a translated comment, hover over a
  translated title or commit message, or switch the whole page with the floating button or
  the configurable shortcut (**Alt+Shift+J** by default).
- **Code and formatting.** Keep code blocks, inline code, identifiers such as `getUserName` and
  `user_id`, link destinations, @mentions, issue references, conventional commit prefixes and Git
  trailers intact. Preserve the structure of Markdown lists and tables.
- **Translation as you browse.** Content is queued as it comes near the visible part of the page.
  The extension skips text already in the target language and picks up new or edited comments
  and navigation within GitHub.
- **On-device translation.** Chrome downloads a model the first time you translate a language pair.
  Translation runs on your device, and the extension stores your preferences locally.
