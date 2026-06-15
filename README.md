# pi-diff-review-wsl

A WSL2-adapted fork of [pi-diff-review](https://github.com/badlogic/pi-diff-review) by Mario Zechner.

Adds a `/diff-review` command to [pi](https://pi.dev) that opens a native diff review window. The original extension works on macOS, Linux, and Windows. This fork specifically handles the **WSL2 + Windows** case where the pi agent runs in WSL2 but the native window must render on the Windows desktop via WebView2.

## What it does

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

- WSL2 with a Linux distro
- Windows Node.js installed, typically at `C:\Program Files\nodejs\node.exe`
- Windows .NET 8 SDK or newer (required for the `glimpseui` postinstall Windows build)
- WebView2 Runtime (pre-installed on Windows 10/11)
- Git repository in the current project
- Internet access for the Tailwind and Monaco CDNs used by the review window

Check from WSL2:

```bash
powershell.exe -Command "node --version"
powershell.exe -Command "dotnet --list-sdks"
```

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

### Reviewing against a specific base branch

By default, `/diff-review` shows only uncommitted changes on the current branch (working tree vs `HEAD`).

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
    "extensions": ["./src/index.ts"]
  }
}
```

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

## License

Same as the original project.
