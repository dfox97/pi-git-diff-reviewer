---
description: Open a native diff review window. Comments become the next user message.
agent: build
---

This command is intercepted by the `diff-review` plugin: instead of sending
this template to the LLM, the plugin opens a native diff review window in
a separate OS window, lets you draft per-file / per-line comments across
`git diff`, `last commit`, `all files`, and individual commit scopes, then
replaces this message with the composed feedback prompt.

Usage:

- `/diff-review` — review uncommitted working-tree changes vs `HEAD`
- `/diff-review <base-branch>` — review the whole feature branch against
  its merge base with `<base-branch>` (e.g. `main`, `dev`)
