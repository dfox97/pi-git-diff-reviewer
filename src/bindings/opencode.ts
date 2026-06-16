/**
 * opencode plugin binding for the agent-agnostic diff-review core.
 *
 * Two entry points, both funnelling through the same `runReviewFlow`:
 *
 *   1. A custom tool `diff_review` that the LLM can call.
 *   2. A `command.execute.before` hook so when the user types
 *      `/diff-review [base]` directly in the TUI, the diff window opens
 *      without an LLM round-trip and the composed feedback replaces the
 *      message that gets fed to the LLM — the same UX as the pi binding's
 *      "insert into the editor".
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { TextPart } from "@opencode-ai/sdk";
import {
	composeReviewPrompt,
	getReviewWindowData,
	openReviewWindow,
	type Exec,
	type ExecResult,
} from "../core/index.js";

/**
 * Inlined scope for `Bun.spawn` so this binding remains the only file in the
 * project that depends on the Bun runtime. Full `Bun` typings live in
 * `@types/bun` (devDep) but are not pulled in here.
 */
declare const Bun: {
	spawn(
		cmd: string[],
		opts: { cwd?: string; stdout?: "pipe"; stderr?: "pipe" },
	): {
		stdout: ReadableStream;
		stderr: ReadableStream;
		exited: Promise<number>;
	};
};

/**
 * Adapt opencode's Bun runtime to the agent-agnostic `Exec` interface
 * defined in `core/git.ts`. Uses `Bun.spawn` directly (instead of Bun's
 * `$` shell) because git is invoked many times with structured stdout and
 * we want predictable `{code, stdout, stderr}` triples.
 */

function makeExec(): Exec {
	return async (cmd, args, opts): Promise<ExecResult> => {
		let proc;
		try {
			proc = Bun.spawn([cmd, ...args], {
				cwd: opts.cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (err) {
			// Bun.spawn throws synchronously if the binary can't be exec'd
			// (ENOENT, EACCES, …). Surface as a 127-style result so callers
			// see the same shape they see for any other failure.
			const message = err instanceof Error ? err.message : String(err);
			return { code: 127, stdout: "", stderr: message };
		}

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		return { code: exitCode, stdout, stderr };
	};
}

/**
 * Single source of truth for the entire review session. Used by both the
 * custom tool and the command hook so behaviour is identical regardless
 * of how the user (or the LLM) triggered diff-review.
 */
async function runReviewFlow(exec: Exec, cwd: string, baseBranch?: string): Promise<string> {
	const data = await getReviewWindowData(exec, cwd, baseBranch);
	if (data.files.length === 0) {
		return "No reviewable files found.";
	}

	const handle = openReviewWindow(exec, data, {
		width: 1680,
		height: 1020,
		title: "opencode review",
	});

	try {
		const message = await handle.result;
		if (message == null || message.type === "cancel") {
			return "Review cancelled.";
		}
		return composeReviewPrompt(data.files, message);
	} finally {
		handle.close();
	}
}

/**
 * Generate a unique id for the synthetic TextPart we inject. Not a UUID —
 * just a session+timestamp hashed enough for opencode's part list to keep
 * us straight from any genuine user message that arrived earlier.
 */
function newPartId(sessionID: string): string {
	return `${sessionID}-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const DiffReviewPlugin: Plugin = async () => {
	const exec = makeExec();

	return {
		tool: {
			diff_review: tool({
				description:
					"Open a native diff review window in a separate OS window. " +
					"Lets the user switch between git-diff, last commit, all files, " +
					"and individual commit scopes; draft comments per-file / per-line " +
					"on original or modified sides; submit a single feedback prompt " +
					"back as the tool's return value. " +
					"Without a base branch, reviews only uncommitted working-tree " +
					"changes vs HEAD. Pass an optional `baseBranch` (e.g. 'main', 'dev') " +
					"to review all changes on the current branch since the merge base.",
				args: {
					baseBranch: tool.schema
						.string()
						.optional()
						.describe("Optional base branch — reviews the feature branch against its merge base with this branch."),
				},
				async execute(args, ctx) {
					return runReviewFlow(exec, ctx.directory, args.baseBranch);
				},
			}),
		},

		/**
		 * opencode fires this for any slash command the TUI executes. We
		 * narrow on `command === "diff-review"` and replace the message parts
		 * with our composed feedback — matching the pi-binding experience of
		 * "review ends → text lands in the editor/LLM context".
		 */
		"command.execute.before": async (input, output) => {
			if (input.command !== "diff-review") return;

			const baseBranch = input.arguments?.trim() || undefined;
			const reviewResult = await runReviewFlow(exec, process.cwd(), baseBranch);

			// Build a fresh TextPart that satisfies the SDK's runtime shape.
			// opencode reads `id, sessionID, messageID` back when rendering the
			// part in chat, so we provide unique values per invocation.
			const part: TextPart = {
				id: newPartId(input.sessionID),
				sessionID: input.sessionID,
				messageID: newPartId(input.sessionID),
				type: "text",
				text: reviewResult,
			};

			output.parts.length = 0;
			output.parts.push(part);
		},
	};
};
