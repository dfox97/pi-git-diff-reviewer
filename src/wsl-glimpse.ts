import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

function ensureWindowsGlimpseInstalled(): string {
  const windowsInstallDir = toWindowsPath(WINDOWS_INSTALL_DIR);
  const glimpsePath = join(WINDOWS_INSTALL_DIR, "node_modules", "glimpseui", "src", "glimpse.mjs");

  if (existsSync(glimpsePath)) {
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
  const result = spawnSync("cmd.exe", ["/c", "cd", "/d", windowsInstallDir, "&&", npmCmd, "install", "glimpseui"], {
    stdio: "inherit",
    timeout: 300000,
  });

  if (result.status !== 0) {
    throw new Error(`Failed to install glimpseui in Windows: npm install exited with ${result.status ?? "unknown"}`);
  }

  if (!existsSync(glimpsePath)) {
    throw new Error("glimpseui installation completed but the expected file was not found.");
  }

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

export function open(
  html: string,
  options?: import("glimpseui").GlimpseOpenOptions,
): import("glimpseui").GlimpseWindow {
  if (isWSL()) {
    return openWSL(html, options) as unknown as import("glimpseui").GlimpseWindow;
  }

  return nativeOpen(html, options);
}
