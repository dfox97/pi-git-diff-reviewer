/**
 * Standalone CLI binding for the agent-agnostic diff-review core.
 *
 * Contract (Q9/Q10): the tool is a pure human-input device — it never triggers
 * an LLM. It produces a draft prompt for the human; cancel/close/empty yields
 * no prompt.
 *
 *   diff-review open [<branch>] [--base <branch>] [--out <path>]   (agent mode)
 *     Opens the review window. On submit-with-content, writes the raw markdown
 *     prompt to stdout (or `--out` <path>) and exits 0. On cancel/close/empty/
 *     error, writes nothing to stdout, logs to stderr, and exits non-zero.
 *
 *   diff-review [clip] [<branch>] [--base <branch>]     (human mode; default)
 *     Opens the review window. On submit, copies the prompt to the clipboard
 *     and prints a friendly message. Cancel/close just prints "cancelled".
 *
 * The positional branch argument is kept as a short alias for `--base`.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
	composeReviewPrompt,
	isWSL,
	openReviewWindow,
	type Exec,
	type ExecResult,
} from "../core/index.js";

function execWithStdin(cmd: string, args: string[], stdin: string): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
		child.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
		child.on("error", (err) => {
			if ("code" in err && err.code === "ENOENT") {
				resolve({ code: 127, stdout: "", stderr: err.message });
				return;
			}
			reject(err);
		});
		child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
		child.stdin.write(stdin, "utf8");
		child.stdin.end();
	});
}

function makeExec(): Exec {
	return async (cmd, args, opts): Promise<ExecResult> => {
		return new Promise((resolve, reject) => {
			const child = spawn(cmd, args, { cwd: opts.cwd });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
			child.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
			child.on("error", (err) => {
				if ("code" in err && err.code === "ENOENT") {
					resolve({ code: 127, stdout: "", stderr: err.message });
					return;
				}
				reject(err);
			});
			child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
		});
	};
}

async function tryCopy(cmd: string, args: string[], text: string): Promise<boolean> {
	try {
		const result = await execWithStdin(cmd, args, text);
		return result.code === 0;
	} catch {
		return false;
	}
}

async function copyToClipboard(text: string): Promise<void> {
	const wsl = isWSL();
	if (wsl) {
		if (await tryCopy("clip.exe", [], text)) return;
		if (await tryCopy("powershell.exe", ["-Command", "$input | Set-Clipboard"], text)) return;
	}
	if (process.platform === "win32") {
		if (await tryCopy("clip", [], text)) return;
		if (await tryCopy("powershell.exe", ["-Command", "$input | Set-Clipboard"], text)) return;
	}
	if (process.platform === "darwin") {
		if (await tryCopy("pbcopy", [], text)) return;
	}
	if (process.platform === "linux" || wsl) {
		if (process.env.WAYLAND_DISPLAY && (await tryCopy("wl-copy", [], text))) return;
		if (await tryCopy("xclip", ["-selection", "clipboard"], text)) return;
		if (await tryCopy("xsel", ["--clipboard", "input"], text)) return;
	}
	throw new Error(
		"Could not copy to clipboard. On Linux install xclip, wl-copy, or xsel; on macOS use pbcopy; on Windows/WSL clip.exe or PowerShell should be available.",
	);
}

interface ParsedArgs {
	subcommand: "open" | "clip";
	baseBranch: string | undefined;
	outPath: string | undefined;
	help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
	const rest = [...argv];
	let subcommand: "open" | "clip" | undefined;
	let baseBranch: string | undefined;
	let outPath: string | undefined;
	let help = false;

	const first = rest.shift();
	if (first === "open" || first === "clip") {
		subcommand = first;
	} else if (first != null) {
		// Treat unknown first token as a flag (e.g. --help) by pushing it back.
		rest.unshift(first);
	}

	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--base") {
			baseBranch = rest[++i];
		} else if (arg.startsWith("--base=")) {
			baseBranch = arg.slice("--base=".length);
		} else if (arg === "--out") {
			outPath = rest[++i];
		} else if (arg.startsWith("--out=")) {
			outPath = arg.slice("--out=".length);
		} else if (!arg.startsWith("-") && baseBranch == null) {
			baseBranch = arg;
		}
	}

	return { subcommand: subcommand ?? "clip", baseBranch, outPath, help };
}

function printUsage(): void {
	console.log("Usage: diff-review [subcommand] [base-branch] [options]");
	console.log("");
	console.log("Subcommands:");
	console.log("  open   Agent mode: print the prompt to stdout (--out for a file).");
	console.log("  clip   Human mode (default): copy the prompt to the clipboard.");
	console.log("");
	console.log("Options:");
	console.log("  --base <branch>   Review against <branch> (same as positional base-branch).");
	console.log("  --out <path>      (open only) write the prompt to <path> instead of stdout.");
	console.log("  -h, --help        Show this help.");
}

function promptHasContent(payload: { overallComment: string; comments: { body: string }[] }): boolean {
	return payload.overallComment.trim().length > 0 || payload.comments.some((comment) => comment.body.trim().length > 0);
}

async function runOpenMode(exec: Exec, cwd: string, baseBranch: string | undefined, outPath: string | undefined): Promise<number> {
	const handle = openReviewWindow(exec, cwd, baseBranch, { width: 1680, height: 1020, title: "diff review" });
	try {
		const payload = await handle.result;
		if (payload == null) {
			console.error("Review window closed without submitting.");
			return 1;
		}
		if (payload.type === "cancel") {
			console.error("Review cancelled.");
			return 1;
		}
		if (!promptHasContent(payload)) {
			console.error("Review submitted with no comments.");
			return 1;
		}
		const data = await handle.data;
		const prompt = composeReviewPrompt(data.files, payload);
		if (outPath != null && outPath.length > 0) {
			writeFileSync(outPath, prompt, "utf8");
		} else {
			process.stdout.write(prompt);
		}
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Review failed: ${message}`);
		return 1;
	} finally {
		handle.close();
	}
}

async function runClipMode(exec: Exec, cwd: string, baseBranch: string | undefined): Promise<number> {
	const handle = openReviewWindow(exec, cwd, baseBranch, { width: 1680, height: 1020, title: "diff review" });
	try {
		const payload = await handle.result;
		if (payload == null || payload.type === "cancel") {
			console.log("Review cancelled.");
			return 0;
		}
		if (!promptHasContent(payload)) {
			console.log("Review submitted with no comments; nothing to copy.");
			return 0;
		}
		const data = await handle.data;
		const prompt = composeReviewPrompt(data.files, payload);
		await copyToClipboard(prompt);
		console.log("Review feedback copied to clipboard.");
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Review failed: ${message}`);
		return 1;
	} finally {
		handle.close();
	}
}

async function main(): Promise<void> {
	const { subcommand, baseBranch, outPath, help } = parseArgs(process.argv.slice(2));
	if (help) {
		printUsage();
		return;
	}

	const exec = makeExec();
	const cwd = process.cwd();
	const code = subcommand === "open"
		? await runOpenMode(exec, cwd, baseBranch, outPath)
		: await runClipMode(exec, cwd, baseBranch);
	process.exit(code);
}

void main();
