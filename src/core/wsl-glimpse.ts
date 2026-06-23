import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { open as nativeOpen } from "glimpseui";

export type { GlimpseInfo, GlimpseOpenOptions, GlimpseWindow } from "glimpseui";

let wslDetected: boolean | null = null;

export function isWSL(): boolean {
  if (wslDetected != null) return wslDetected;

  if (process.platform !== "linux") {
    wslDetected = false;
    return wslDetected;
  }

  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    wslDetected = true;
    return wslDetected;
  }

  try {
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    if (version.includes("microsoft") || version.includes("wsl2")) {
      wslDetected = true;
      return wslDetected;
    }
  } catch {}

  wslDetected = false;
  return wslDetected;
}

function findWindowsNode(): string | null {
  const candidates = [
    "/mnt/c/Program Files/nodejs/node.exe",
    "/mnt/c/Program Files (x86)/nodejs/node.exe",
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  return null;
}

function findWindowsNpm(): string | null {
  const candidates = [
    "/mnt/c/Program Files/nodejs/npm.cmd",
    "/mnt/c/Program Files (x86)/nodejs/npm.cmd",
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  return null;
}

function toWindowsPath(wslPath: string): string {
  const match = wslPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (match) {
    const drive = match[1].toUpperCase();
    const rest = match[2].replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  return wslPath;
}

function toFileUrl(windowsPath: string): string {
  return "file://" + windowsPath.replace(/\\/g, "/");
}

const WINDOWS_INSTALL_DIR = "/mnt/c/temp/pi-wsl-glimpse";

function patchWindowsGlimpseShowInTaskbar(): void {
  const programCsPath = join(
    WINDOWS_INSTALL_DIR,
    "node_modules",
    "glimpseui",
    "native",
    "windows",
    "Program.cs",
  );
  if (!existsSync(programCsPath)) {
    throw new Error("glimpseui Program.cs not found after install.");
  }

  const original = readFileSync(programCsPath, "utf8");
  // Upstream glimpse hardcodes `ShowInTaskbar = false` for the Windows WebView2
  // window, which hides the review window from the taskbar and makes it easy to
  // lose. Flip it so the window shows up like a normal application.
  const patched = original.replace("ShowInTaskbar = false", "ShowInTaskbar = true");
  if (patched === original) {
    // Either already patched or the upstream source changed shape. If it's
    // already patched this is a no-op; if the shape changed, the rebuild still
    // runs and we just don't apply the taskbar tweak.
    console.error(
      "[diff-review] Warning: could not find 'ShowInTaskbar = false' in glimpse Program.cs to patch.",
    );
    return;
  }
  writeFileSync(programCsPath, patched, "utf8");
}

function ensureWindowsGlimpseInstalled(): string {
  const windowsInstallDir = toWindowsPath(WINDOWS_INSTALL_DIR);
  const glimpsePath = join(WINDOWS_INSTALL_DIR, "node_modules", "glimpseui", "src", "glimpse.mjs");
  const patchedMarker = join(WINDOWS_INSTALL_DIR, ".pi-diff-review-taskbar-patched");

  if (existsSync(glimpsePath) && existsSync(patchedMarker)) {
    return toWindowsPath(glimpsePath);
  }

  const nodePath = findWindowsNode();
  const npmPath = findWindowsNpm();

  if (nodePath == null || npmPath == null) {
    throw new Error(
      "Windows Node.js not found. Please install Node.js for Windows and ensure C:\\Program Files\\nodejs\\node.exe exists.",
    );
  }

  try {
    mkdirSync(WINDOWS_INSTALL_DIR, { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create Windows install dir: ${String(e)}`);
  }

  const npmCmd = toWindowsPath(npmPath);

  // Install glimpseui without running its postinstall build. We patch the
  // Windows source first (to enable taskbar presence) and then build ourselves,
  // so we only compile the native binary once.
  if (!existsSync(glimpsePath)) {
    const installResult = spawnSync(
      "cmd.exe",
      ["/c", "cd", "/d", windowsInstallDir, "&&", npmCmd, "install", "glimpseui", "--ignore-scripts"],
      { stdio: "inherit", timeout: 300000 },
    );
    if (installResult.status !== 0) {
      throw new Error(
        `Failed to install glimpseui in Windows: npm install exited with ${installResult.status ?? "unknown"}`,
      );
    }
    if (!existsSync(glimpsePath)) {
      throw new Error("glimpseui installation completed but the expected file was not found.");
    }
  }

  patchWindowsGlimpseShowInTaskbar();

  // `build:windows` is a script on the glimpseui package itself, so run it from
  // inside the installed package directory, not the install root.
  const windowsPackageDir = toWindowsPath(
    join(WINDOWS_INSTALL_DIR, "node_modules", "glimpseui"),
  );
  const buildResult = spawnSync(
    "cmd.exe",
    ["/c", "cd", "/d", windowsPackageDir, "&&", npmCmd, "run", "build:windows"],
    { stdio: "inherit", timeout: 300000 },
  );
  if (buildResult.status !== 0) {
    throw new Error(
      `Failed to build patched glimpseui for Windows: build exited with ${buildResult.status ?? "unknown"}`,
    );
  }

  writeFileSync(patchedMarker, new Date().toISOString(), "utf8");
  return toWindowsPath(glimpsePath);
}

function makeWindowsTempDir(): string {
  const base = "/mnt/c/temp";
  try {
    mkdirSync(base, { recursive: true });
  } catch {}

  const dir = `${base}/pi-diff-review-wsl-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create Windows temp dir: ${String(e)}`);
  }

  return dir;
}

function cleanupWindowsTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function buildHostScript(glimpsePath: string): string {
  return `
import { open } from '${toFileUrl(glimpsePath)}';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const optionsPath = process.argv[2];
const htmlPath = process.argv[3];
const options = { ...JSON.parse(readFileSync(optionsPath, 'utf8')), hidden: true };

// Open a placeholder window with a dark background matching the review app, then
// load the real HTML from a file. WebView2's NavigateToString has a size limit, so
// large diffs must be loaded via file. We show the window immediately after
// starting the file load so it feels responsive; the placeholder is barely visible.
const placeholder = '<html><head></head><body style="margin:0;background:#1a1a2e"></body></html>';
const win = open(placeholder, options);
let placeholderReady = false;

function send(type, payload) {
  process.stdout.write(JSON.stringify({ type, ...payload }) + '\\n');
}

win.on('ready', (info) => {
  if (!placeholderReady) {
    placeholderReady = true;
    win.loadFile(htmlPath);
    win.show();
    return;
  }
  send('ready', { info });
});
win.on('message', (data) => send('message', { data }));
win.on('info', (info) => send('info', { info }));
win.on('closed', () => send('closed', {}));
win.on('error', (error) => send('error', { message: error.message || String(error) }));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    switch (msg.type) {
      case 'send': win.send(msg.js); break;
      case 'setHTML': win.setHTML(msg.html); break;
      case 'show': win.show(msg.title != null ? { title: msg.title } : {}); break;
      case 'close': win.close(); break;
      case 'getInfo': win.getInfo(); break;
      case 'loadFile': win.loadFile(msg.path); break;
      case 'followCursor': win.followCursor(msg.enabled, msg.anchor, msg.mode); break;
      default: break;
    }
  } catch {}
});

process.stdin.on('end', () => {
  try { win.close(); } catch {}
});
`;
}

class WSLGlimpseWindow extends EventEmitter {
  #proc: import("node:child_process").ChildProcessWithoutNullStreams;
  #tempDir: string;
  #closed = false;
  info: import("glimpseui").GlimpseInfo | null = null;

  constructor(
    proc: import("node:child_process").ChildProcessWithoutNullStreams,
    tempDir: string,
  ) {
    super();
    this.#proc = proc;
    this.#tempDir = tempDir;

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      switch (msg.type) {
        case "ready":
        case "info":
          this.info = msg.info ?? null;
          this.emit(msg.type, msg.info);
          break;
        case "message":
          this.emit("message", msg.data);
          break;
        case "closed":
          this.#cleanup();
          this.emit("closed");
          break;
        case "error":
          this.emit("error", new Error(msg.message ?? "Unknown Glimpse error"));
          break;
        default:
          break;
      }
    });

    proc.on("error", (err) => {
      this.emit("error", err);
      this.#cleanup();
    });

    proc.on("exit", () => {
      this.#cleanup();
      if (!this.#closed) {
        this.#closed = true;
        this.emit("closed");
      }
    });
  }

  #cleanup(): void {
    if (!this.#closed) {
      this.#closed = true;
      try {
        this.#proc.stdin.end();
      } catch {}
      cleanupWindowsTempDir(this.#tempDir);
    }
  }

  send(js: string): void {
    if (this.#closed) return;
    this.#proc.stdin.write(JSON.stringify({ type: "send", js }) + "\n");
  }

  setHTML(html: string): void {
    if (this.#closed) return;
    this.#proc.stdin.write(JSON.stringify({ type: "setHTML", html }) + "\n");
  }

  show(options?: { title?: string }): void {
    if (this.#closed) return;
    const msg: Record<string, unknown> = { type: "show" };
    if (options?.title != null) msg.title = options.title;
    this.#proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  close(): void {
    if (this.#closed) return;
    this.#proc.stdin.write(JSON.stringify({ type: "close" }) + "\n");
  }

  loadFile(path: string): void {
    if (this.#closed) return;
    this.#proc.stdin.write(JSON.stringify({ type: "loadFile", path }) + "\n");
  }

  getInfo(): void {
    if (this.#closed) return;
    this.#proc.stdin.write(JSON.stringify({ type: "getInfo" }) + "\n");
  }

  followCursor(enabled: boolean, anchor?: string, mode?: string): void {
    if (this.#closed) return;
    const msg: Record<string, unknown> = { type: "followCursor", enabled };
    if (anchor !== undefined) msg.anchor = anchor;
    if (mode !== undefined) msg.mode = mode;
    this.#proc.stdin.write(JSON.stringify(msg) + "\n");
  }
}

function openWSL(html: string, options?: import("glimpseui").GlimpseOpenOptions): WSLGlimpseWindow {
  const nodePath = findWindowsNode();
  if (nodePath == null) {
    throw new Error(
      "Could not find Windows Node.js. Please install Node.js for Windows.",
    );
  }

  const glimpsePath = ensureWindowsGlimpseInstalled();
  const tempDir = makeWindowsTempDir();

  try {
    writeFileSync(join(tempDir, "host.mjs"), buildHostScript(glimpsePath), "utf8");
    writeFileSync(join(tempDir, "html.html"), html, "utf8");
    writeFileSync(join(tempDir, "options.json"), JSON.stringify(options ?? {}), "utf8");
  } catch (e) {
    cleanupWindowsTempDir(tempDir);
    throw new Error(`Failed to write WSL Glimpse host files: ${String(e)}`);
  }

  const hostPath = toWindowsPath(join(tempDir, "host.mjs"));
  const optionsPath = toWindowsPath(join(tempDir, "options.json"));
  const htmlPath = toWindowsPath(join(tempDir, "html.html"));

  const proc = spawn(nodePath, [hostPath, optionsPath, htmlPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  if (proc.stdin == null || proc.stdout == null) {
    cleanupWindowsTempDir(tempDir);
    throw new Error("Failed to spawn WSL Glimpse host process");
  }

  return new WSLGlimpseWindow(proc, tempDir);
}

function findCachedChromium(): string | null {
  const cacheDir = join(homedir(), ".cache", "pi-diff-review", "chromium");
  if (!existsSync(cacheDir)) return null;

  try {
    const revisions = readdirSync(cacheDir).filter((d) => d.startsWith("linux-"));
    if (revisions.length === 0) return null;

    // Use the latest revision (highest numbered)
    const latest = revisions.sort().pop()!;
    const chromePath = join(cacheDir, latest, "chrome-linux", "chrome");
    if (existsSync(chromePath)) return chromePath;
  } catch {}

  return null;
}

function downloadChromium(): string | null {
  const cacheDir = join(homedir(), ".cache", "pi-diff-review");
  mkdirSync(cacheDir, { recursive: true });

  console.error("[diff-review] Chromium not found. Downloading...");
  const result = spawnSync(
    "npx",
    ["-y", "@puppeteer/browsers", "install", "chromium@latest", "--path", cacheDir],
    { stdio: "inherit", timeout: 300000 },
  );

  if (result.status !== 0) {
    console.error("[diff-review] Failed to download Chromium.");
    return null;
  }

  return findCachedChromium();
}

function ensureLinuxChromiumAvailable(): void {
  // Already configured
  if (process.env.GLIMPSE_CHROME_PATH) return;
  // Native glimpse binary takes precedence
  if (process.env.GLIMPSE_BACKEND === "native") return;

  // Check for system Chromium
  const candidates = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "chrome"];
  for (const cmd of candidates) {
    const result = spawnSync("which", [cmd], { stdio: "ignore" });
    if (result.status === 0) return;
  }

  // Check for cached Chromium
  const cached = findCachedChromium();
  if (cached) {
    process.env.GLIMPSE_CHROME_PATH = cached;
    return;
  }

  // Download Chromium
  const downloaded = downloadChromium();
  if (downloaded) {
    process.env.GLIMPSE_CHROME_PATH = downloaded;
  }
}

export function open(
  html: string,
  options?: import("glimpseui").GlimpseOpenOptions,
): import("glimpseui").GlimpseWindow {
  if (isWSL()) {
    return openWSL(html, options) as unknown as import("glimpseui").GlimpseWindow;
  }

  // On native Linux, ensure Chromium is available (download if needed)
  if (process.platform === "linux") {
    ensureLinuxChromiumAvailable();
  }

  return nativeOpen(html, options);
}
