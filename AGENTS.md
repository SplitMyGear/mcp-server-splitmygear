# Agent Instructions

Rules for AI coding agents (and humans) working in this repository.

## Git Branch Naming

Applies to every branch an AI agent (Claude Code, Codex, etc.) or a human creates in this repo.

- **Format:** `<type>/SPLIT-<ticket>-<short-slug>`
  - `<type>` is one of `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf` (the same types as our commit messages).
  - `SPLIT-<ticket>` is the Jira ticket key. Name every ticket when a branch covers several: `fix/SPLIT-1632-SPLIT-1634-admin-email`.
  - `<short-slug>` is lowercase, hyphen-separated, a few words at most.
- **Examples:** `fix/SPLIT-1650-message-splitter-listing`, `feat/SPLIT-1641-report-review`, `chore/SPLIT-1646-prod-advisories`.
- **Never** prefix a branch with `claude/`, `codex/`, `ai/`, a tool name, or a username, and never add random suffixes like `-znf06q`.
- No ticket yet? Ask for one before creating the branch rather than inventing a number.
