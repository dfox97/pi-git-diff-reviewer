# pi-diff-review-wsl

Adds a `/diff-review` command to [pi](https://pi.dev) that opens a native diff review window. The original extension works on macOS, Linux, and Windows. This fork specifically handles the **WSL2 + Windows** case where the pi agent runs in WSL2 but the native window must render on the Windows desktop via WebView2.

## Currently:
Usable with pi, opencode and supports cli command `/diff-review` so any comments made during feedback get saved to clipboard, you can then paste them into your agent editor or your choice, works well with claude code this way. 

## What it does

<img width="800" height="435" alt="Recording2026-06-15164816-ezgif com-optimize" src="https://github.com/user-attachments/assets/e3fad66f-230c-414c-aa93-19bcaad2a232" />

Same as the original:

- Opens a native review window
- Lets you switch between `git diff`, `last commit`, and `all files` scopes
- Shows a collapsible sidebar with fuzzy file search
- Shows git status markers in the sidebar
- Lazy-loads file contents on demand
- Lets you draft comments on the original, modified, or file level
- Inserts the resulting feedback prompt into the pi editor on submit

## How it works on WSL2

The original extension imports `glimpseui` directly, which on WSL2 tries to use the Linux backend. In many WSL2 setups the Linux backend cannot open a stable window.

This fork adds a tiny wrapper (`src/wsl-glimpse.ts`) that:

1. Detects WSL2 at runtime.
2. When running in WSL2, it installs `glimpseui` into a Windows directory (`C:\temp\pi-wsl-glimpse`) if it is not already there.
3. Spawns a Windows `node.exe` process that opens the Glimpse window using the native Windows WebView2 backend.
4. Streams the Glimpse JSON Lines protocol over stdin/stdout between the WSL2 extension and the Windows host.

When not running in WSL2, the wrapper re-exports `glimpseui` directly, so the behavior on macOS, Linux, and native Windows is unchanged.

## Prerequisites

All platforms require:
- A **git repository** in the current working directory
- **Internet access** (the review UI loads Tailwind CSS and Monaco Editor from CDNs)

Platform-specific requirements below.

---

### Native Linux (Fedora, Ubuntu, Arch, etc.)

The extension uses [glimpseui](https://github.com/nickvdyck/glimpseui)'s Chromium CDP backend on native Linux.

| Dependency | Required? | Notes |
|---|---|---|
| **Chromium** | Yes | Auto-downloaded to `~/.cache/pi-diff-review/chromium/` on first run if not found on `PATH`. You can also install it system-wide. |
| **xdotool** | Recommended | Used for window positioning, floating, and focus management. Without it the window still opens but may not position correctly. |

**Option A — Let it auto-download (zero setup):**

Just run `/diff-review`. If no system Chromium is found, the extension downloads one automatically via `@puppeteer/browsers` to `~/.cache/pi-diff-review/`. This only happens once.

**Option B — Install system Chromium + xdotool:**

```bash
# Fedora
sudo dnf install -y chromium xdotool

# Ubuntu / Debian
sudo apt install -y chromium-browser xdotool

# Arch
sudo pacman -S chromium xdotool
```

**Option C — Point to a custom Chromium binary:**

```bash
export GLIMPSE_CHROME_PATH=/path/to/your/chrome-or-chromium
```

**Verify it works:**

```bash
which chromium || echo "Will auto-download on first run"
which xdotool || echo "Window positioning may be limited"
```

---

### WSL2 (Windows Subsystem for Linux)

The extension detects WSL2 at runtime and routes the window through Windows Node.js + WebView2 so it renders natively on the Windows desktop.

| Dependency | Where | How to check |
|---|---|---|
| **Node.js for Windows** | `C:\Program Files\nodejs\node.exe` | `powershell.exe -Command "node --version"` |
| **.NET 8 SDK** (or newer) | Windows | `powershell.exe -Command "dotnet --list-sdks"` |
| **WebView2 Runtime** | Windows | Pre-installed on Windows 10/11 |

**Install missing dependencies:**

1. **Node.js for Windows** — Download from <https://nodejs.org> and install for Windows (not the WSL Linux version). Verify from WSL:
   ```bash
   powershell.exe -Command "node --version"
   ```

2. **.NET 8 SDK** — Download from <https://dotnet.microsoft.com/download/dotnet/8.0> and install for Windows. The `glimpseui` postinstall script uses it to build the native Windows host. Verify from WSL:
   ```bash
   powershell.exe -Command "dotnet --list-sdks"
   ```

3. **WebView2 Runtime** — Already present on Windows 10 (Chromium-based) and Windows 11. If missing, install from <https://developer.microsoft.com/en-us/microsoft-edge/webview2/>.

**First-run note:** The first time you run `/diff-review` in WSL2, the wrapper installs `glimpseui` into `C:\temp\pi-wsl-glimpse` using the Windows npm. This builds the Windows native host and may take 30–60 seconds. Subsequent runs are fast.

---

### macOS

The extension uses glimpseui's native Swift/WebKit backend. No extra dependencies — just install and run.

## Install

> **Important:** Do not install this alongside the original `pi-diff-review`. Both extensions register the `/diff-review` command, so they will conflict. Use this WSL2 fork instead if you are working inside WSL2.

### Option A: Install directly in pi

```bash
pi install git:https://github.com/YOUR_USERNAME/pi-diff-review-wsl
```

(Replace `YOUR_USERNAME` with your GitHub user after publishing.)

### Option B: Install locally from this folder

```bash
cd /home/danny/personal/projects/pi-diff-review-wsl
pi install .
```

### Option C: Use as a local project extension

```bash
pi install /home/danny/personal/projects/pi-diff-review-wsl
```

> The local copy in `/home/danny/personal/projects/pi-diff-review-wsl` is **not active** until you run one of the install commands above.

### Replacing the original extension

If you previously installed the original `pi-diff-review`, remove it first:

```bash
pi remove git:https://github.com/badlogic/pi-diff-review
```

Then install this WSL2 version.

## Usage

Inside a git repository in pi:

```
/diff-review
```

A native Windows window opens with the diff review UI.

## Standalone CLI

You can also run diff-review directly from your normal shell, outside of any AI agent. The composed feedback is copied to your clipboard on submit instead of being inserted into an editor or chat box.

### Run locally from this repo

```bash
cd /home/danny/personal/projects/pi-diff-review-wsl
npm install       # installs tsx for the dev fallback
./bin/diff-review [base-branch]
```

### Install the command as `diff-review`

```bash
cd /home/danny/personal/projects/pi-diff-review-wsl
npm run build     # compile the CLI to dist/
npm link          # makes `diff-review` available globally
diff-review [base-branch]
```

To type `/diff-review` literally in your shell, add an alias to your shell config (e.g. `~/.bashrc` or `~/.zshrc`):

```bash
alias /diff-review=diff-review
```

### Clipboard requirements

- **WSL2 / Windows**: `clip.exe` or PowerShell is used automatically.
- **macOS**: `pbcopy` is built-in.
- **Linux**: install one of `xclip`, `wl-copy` (Wayland), or `xsel`. The CLI tries them in that order.

## Reviewing against a specific base branch

By default, `diff-review` (or `/diff-review` in pi/opencode) shows only uncommitted changes on the current branch (working tree vs `HEAD`).

If you want to review the entire feature branch against a different base branch (e.g., `dev` or `main`), pass it as an argument:

```
/diff-review dev
```

This compares `HEAD` against the merge base of `dev` and shows all commits and files introduced on the feature branch.

## First-run note

The first time you run `/diff-review` in WSL2, the wrapper installs `glimpseui` into `C:\temp\pi-wsl-glimpse` using the Windows npm. This builds the Windows native host and may take 30–60 seconds. Subsequent runs are fast.

## Packaging as a pi extension

This package is already configured to be a pi package:

```json
{
  "name": "pi-diff-review-wsl",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/bindings/pi.ts"]
  }
}
```

## Architecture

The package is split into three layers:

- `src/core/` — agent-agnostic. The git pipeline (`Exec` is injected, not pulled from any specific runtime), prompt composer, HTML builder, and the window orchestrator. No `pi-coding-agent`, `pi-tui`, or `@opencode-ai/*` imports.
- `src/bindings/pi.ts` — thin pi-specific adapter. Registers the `/diff-review` command, draws the "Waiting for review" TUI panel, races the escape key against the window result, and inserts the composed feedback into the editor.
- `src/bindings/opencode.ts` — thin opencode-specific adapter. Defines a custom tool (`diff_review`) the LLM can call and hooks `command.execute.before` so the user can type `/diff-review [base]` directly in the TUI. The slash-command path inserts the composed feedback into the chat box as a draft, matching the pi-binding's "insert into the editor" UX.

Any other agentic tool (Claude Code, Codex, …) can drop in its own binding alongside by importing from `src/core/index.js` and supplying its own `Exec` implementation. `src/index.ts` is a barrel re-exporting the core for direct consumers.

## opencode support

To run the opencode binding locally in this folder:

1. Make sure opencode's local plugin deps are present:
   ```bash
   cd .opencode && bun add @opencode-ai/plugin
   ```
   This populates `.opencode/node_modules/` (gitignored). If you already have opencode installed system-wide, it will resolve these from the user's global cache.
2. From the repo root, start opencode:
   ```bash
   opencode
   ```
3. Type `/diff-review` (or `/diff-review main`) in the TUI.

What happens:

- opencode discovers `.opencode/plugins/diff-review.ts` → re-exports `DiffReviewPlugin` from `../../src/bindings/opencode.js`.
- The plugin's `command.execute.before` hook fires for `diff-review`, opens the native Glimpse window via `core/`, awaits the user's submit/cancel, then **inserts** the composed feedback prompt into the opencode chat box as a draft. Press Enter to send it to the LLM.
- If you instead let the LLM call the `diff_review` tool directly (e.g. “please review my diff”), the same flow runs but through the custom-tool path.

To publish:

1. Fork or push this directory to a GitHub repo.
2. Tag a release.
3. Install with `pi install git:https://github.com/YOUR_USERNAME/pi-diff-review-wsl`.

To publish to npm:

```bash
npm publish
# Then install with pi install npm:pi-diff-review-wsl
```

## Fixes and workarounds

### WebView2 `NavigateToString` size limit (Windows / WSL2)

On Windows, WebView2’s `NavigateToString` method cannot accept very large HTML strings. In a large repo or branch, the generated review HTML can exceed this limit and throw:

```
System.ArgumentException: Value does not fall within the expected range.
```

**Fix:** `src/wsl-glimpse.ts` now writes the HTML to a file in `C:\temp\pi-diff-review-wsl-*` and loads it via `loadFile()` instead of passing it as an inline string.

### Brief dark placeholder / flicker on open

Because the file is loaded after the window is created, the window first shows a tiny placeholder while the file loads. The placeholder uses a dark background (`#1a1a2e`) that matches the review app, so the flash is minimal. The window is shown immediately after `loadFile()` starts so opening feels responsive, rather than waiting for the file to fully load before revealing the window.

If the flicker is still annoying, you can experiment with the `placeholder` string in `src/wsl-glimpse.ts` or set `hidden: true` and un-hide only after the file finishes loading (slower but no flash).

## Files changed from the original

- `src/wsl-glimpse.ts` — new WSL2 detection and Windows routing wrapper, plus a file-based HTML loader to avoid WebView2’s `NavigateToString` size limit
- `src/git.ts` — supports an optional base branch (`/diff-review <base>`) and computes the merge base
- `src/index.ts` — now imports `open` from `./wsl-glimpse.js` and parses the base-branch argument
- `src/types.ts` — added `ReviewWindowData` interface
- `package.json` — renamed, made publishable, removed `private: true`
- `README.md` — this file

## Refactor vs the original `pi-diff-review`

The original was a single pi-coupled module. This fork reorganises it so the diff-review domain is reusable across agentic coding tools:

- `src/core/git.ts` — git pipeline takes an injected `Exec` (a structural subset of `@earendil-works/pi-coding-agent`'s `ExecOptions`/`ExecResult`, so pi drops in directly) instead of depending on `ExtensionAPI`
- `src/core/review-window.ts` — owns the message protocol (open window, lazy-load on `request-file`, settle on submit/cancel/closed) and exposes `{ result, close }` so bindings can race cancellation
- `src/core/{types,prompt,ui,wsl-glimpse}.ts` — moved as-is (already pi-free)
- `src/core/index.ts` — public API barrel
- `src/bindings/pi.ts` — slim pi adapter (was `src/index.ts`); only file in the repo that imports `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`
- `src/bindings/opencode.ts` — slim opencode adapter. Defines a custom `diff_review` tool and hooks `command.execute.before` so a `/diff-review` slash command opens the review window and inserts the composed feedback into the chat box as a draft
- `.opencode/plugins/diff-review.ts` — opencode's loader entry; thin re-export of the binding
- `.opencode/commands/diff-review.md` — slash command the user types
- `src/bindings/cli.ts` — standalone shell adapter. Opens the review window and copies the composed feedback to the clipboard on submit; no AI agent required
- `bin/diff-review` — executable entry point that uses the compiled `dist` output if available, otherwise falls back to `tsx` for local development
- `src/index.ts` — root barrel re-exporting the core for direct consumers
- `package.json` — `pi.extensions` now points at `./src/bindings/pi.ts`; `@opencode-ai/plugin` + `@opencode-ai/sdk` + `@types/bun` are devDeps for typechecking the opencode binding; `bin` points at `./bin/diff-review`

## Adapted from:
A WSL2-adapted fork of [pi-diff-review](https://github.com/badlogic/pi-diff-review) by Mario Zechner.
