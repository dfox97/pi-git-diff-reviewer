import { open, type GlimpseOpenOptions, type GlimpseWindow } from "../../platform/wsl-glimpse.js";
import { resolveLoadFilePath } from "../../platform/resolve-web-dir.js";
import { getReviewWindowData } from "../git/index.js";
import { ReviewFileContentCache } from "../git/contents.js";
import { buildPlaceholderHtml } from "../ui.js";
import { openInEditor } from "../editor.js";
import { isCancel, isOpenInEditor, isReady, isRequestFile, isSubmit } from "./protocol.js";
import type { Exec } from "../git/types.js";
import type {
	ReviewCancelPayload,
	ReviewFile,
	ReviewFileContents,
	ReviewHostMessage,
	ReviewOpenInEditorPayload,
	ReviewRequestFilePayload,
	ReviewScope,
	ReviewSubmitPayload,
	ReviewWindowData,
	ReviewWindowMessage,
} from "../types.js";

function escapeForInlineScript(value: string): string {
	return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export interface OpenReviewWindowOptions {
	width?: number;
	height?: number;
	title?: string;
}

export interface OpenReviewWindowHandle {
	/**
	 * Resolves to the gathered review data once the git pipeline completes.
	 * Rejects if gathering fails. Bindings use this to compose the final prompt.
	 */
	readonly data: Promise<ReviewWindowData>;
	/**
	 * Resolves to the submit payload, the cancel payload, or `null` when the
	 * window was closed externally. Rejects on a window/gather error.
	 */
	readonly result: Promise<ReviewSubmitPayload | ReviewCancelPayload | null>;
	/** Programmatically closes the window. Safe to call more than once. */
	close(): void;
}

function scopedFilesFor(
	data: ReviewWindowData,
	scope: ReviewScope,
	commitSha: string | undefined,
): ReviewFile[] {
	switch (scope) {
		case "git-diff":
			return data.files.filter((file) => file.inGitDiff);
		case "last-commit":
			return data.files.filter((file) => file.inLastCommit);
		case "commit":
			return data.files.filter((file) => (commitSha ? file.commitComparisons[commitSha] : false));
		default:
			return data.files.filter((file) => file.hasWorkingTreeFile);
	}
}

/**
 * Internal entry: opens the window immediately, loads the real review page via
 * `loadFile`, and sends `init` + `files` once the webview reports `ready` and
 * `dataPromise` has settled. Bindings use {@link openReviewWindow} (which
 * gathers data internally) or {@link openReviewWindowWithData} (for tests /
 * pre-built data).
 */
function openWindowInternal(
	exec: Exec,
	dataPromise: Promise<ReviewWindowData>,
	options: OpenReviewWindowOptions = {},
): OpenReviewWindowHandle {
	const glimpseOptions: GlimpseOpenOptions = {
		width: options.width ?? 1680,
		height: options.height ?? 1020,
		title: options.title ?? "review",
	};
	const window: GlimpseWindow = open(buildPlaceholderHtml(glimpseOptions.title), glimpseOptions);

	let realPageLoaded = false;
	let appReady = false;
	let fileMap = new Map<string, ReviewFile>();
	let cache: ReviewFileContentCache | null = null;

	const send = (message: ReviewHostMessage): void => {
		const payload = escapeForInlineScript(JSON.stringify(message));
		window.send(`window.__reviewReceive(${payload});`);
	};

	const sendBatch = (messages: ReviewHostMessage[]): void => {
		const script = messages
			.map((message) => `window.__reviewReceive(${escapeForInlineScript(JSON.stringify(message))});`)
			.join("");
		window.send(script);
	};

	// Track data resolution so request-file handlers can await it.
	let dataResolved: ReviewWindowData | null = null;
	const dataHandled = dataPromise
		.then((data) => {
			dataResolved = data;
			fileMap = new Map(data.files.map((file) => [file.id, file]));
			cache = new ReviewFileContentCache(exec, data.repoRoot, data.mergeBase);
			return data;
		});

	const result = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve, reject) => {
		let settled = false;

		const cleanup = (): void => {
			window.removeListener("message", onMessage);
			window.removeListener("ready", onReady);
			window.removeListener("closed", onClosed);
			window.removeListener("error", onError);
		};

		const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};

		const fail = (err: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		// A gather failure must fail `result` (and close the window) regardless of
		// whether the webview ever sent `ready`. Attaching this also marks the
		// `dataHandled` rejection as handled so it never surfaces as an
		// unhandled rejection if a binding never awaits `handle.data`.
		dataHandled.catch((err) => {
			fail(err instanceof Error ? err : new Error(String(err)));
			try {
				window.close();
			} catch {}
		});

		const onReady = (): void => {
			// The glimpse window finished loading the placeholder. Swap in the
			// real review page from disk so relative refs to app.js / vendor
			// resolve. Only do this once; subsequent `ready` events (e.g. after
			// the real page loads) are ignored — we wait for the app's `ready`
			// message instead.
			if (realPageLoaded) return;
			realPageLoaded = true;
			try {
				window.loadFile(resolveLoadFilePath("index.html"));
			} catch (err) {
				fail(err instanceof Error ? err : new Error(String(err)));
			}
		};

		const sendInitAndFiles = async (): Promise<void> => {
			try {
				const data = await dataHandled;
				sendBatch([
					{
						type: "init",
						repoRoot: data.repoRoot,
						baseBranch: data.baseBranch,
						mergeBase: data.mergeBase,
					},
					{ type: "files", files: data.files, commits: data.commits },
				]);
			} catch (err) {
				fail(err instanceof Error ? err : new Error(String(err)));
				try {
					window.close();
				} catch {}
			}
		};

		const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
			let data: ReviewWindowData;
			try {
				data = await dataHandled;
			} catch {
				return; // gather failed; failure already propagated via result.
			}
			const file = fileMap.get(message.fileId);
			if (file == null || cache == null) {
				send({
					type: "file-error",
					requestId: message.requestId,
					fileId: message.fileId,
					scope: message.scope,
					commitSha: message.commitSha,
					message: "Unknown file requested.",
				});
				return;
			}
			try {
				const contents: ReviewFileContents = await cache.get(file, message.scope, message.commitSha);
				send({
					type: "file-data",
					requestId: message.requestId,
					fileId: message.fileId,
					scope: message.scope,
					commitSha: message.commitSha,
					originalContent: contents.originalContent,
					modifiedContent: contents.modifiedContent,
				});
				prefetchNext(data, file, message.scope, message.commitSha);
			} catch (err) {
				const messageText = err instanceof Error ? err.message : String(err);
				send({
					type: "file-error",
					requestId: message.requestId,
					fileId: message.fileId,
					scope: message.scope,
					commitSha: message.commitSha,
					message: messageText,
				});
			}
		};

		const handleOpenInEditor = async (message: ReviewOpenInEditorPayload): Promise<void> => {
			let data: ReviewWindowData;
			try {
				data = await dataHandled;
			} catch {
				return;
			}
			const file = fileMap.get(message.fileId);
			if (file == null) return;
			// Open the working-tree file (`file.path`); for deleted files the path
			// won't exist on disk and the editor will open an empty buffer for it.
			openInEditor({
				repoRoot: data.repoRoot,
				relPath: file.path,
				line: message.line,
			});
			// Minimize the review window so the editor (e.g. a tmux pane) is visible.
			// Only the WSL-patched glimpse native implements `minimize`; on other
			// backends this is a no-op.
			try {
				(window as { minimize?: () => void }).minimize?.();
			} catch {}
		};

		const prefetchNext = (
			data: ReviewWindowData,
			file: ReviewFile,
			scope: ReviewScope,
			commitSha: string | undefined,
		): void => {
			if (cache == null) return;
			const list = scopedFilesFor(data, scope, commitSha);
			const index = list.findIndex((entry) => entry.id === file.id);
			if (index < 0 || index + 1 >= list.length) return;
			cache.prefetch(list[index + 1], scope, commitSha);
		};

		const onMessage = (raw: unknown): void => {
			const msg = raw as ReviewWindowMessage;
			if (isReady(msg)) {
				if (appReady) return;
				appReady = true;
				void sendInitAndFiles();
				return;
			}
			if (isRequestFile(msg)) {
				void handleRequestFile(msg);
				return;
			}
			if (isOpenInEditor(msg)) {
				handleOpenInEditor(msg);
				return;
			}
			if (isSubmit(msg) || isCancel(msg)) {
				settle(msg);
			}
		};

		const onClosed = (): void => {
			settle(null);
		};

		const onError = (err: Error): void => {
			fail(err);
		};

		window.on("ready", onReady);
		window.on("message", onMessage);
		window.on("closed", onClosed);
		window.on("error", onError);
	});

	return {
		data: dataHandled,
		result,
		close: () => {
			try {
				window.close();
			} catch {}
		},
	};
}

/**
 * Open the review window and gather its data internally. The window opens
 * immediately (showing a loading state) while the git pipeline runs; once the
 * webview reports `ready` and the data is gathered, the orchestrator sends
 * `init` + `files` over the message channel. Bindings don't need to gather or
 * sequence anything themselves.
 */
export function openReviewWindow(
	exec: Exec,
	cwd: string,
	baseBranch: string | undefined,
	options: OpenReviewWindowOptions = {},
): OpenReviewWindowHandle {
	const dataPromise = getReviewWindowData(exec, cwd, baseBranch).then((result) => ({
		repoRoot: result.repoRoot,
		files: result.files,
		commits: result.commits,
		baseBranch: result.baseBranch,
		mergeBase: result.mergeBase,
	}));
	return openWindowInternal(exec, dataPromise, options);
}

/**
 * Open the review window with pre-built data (no git gathering). Used by
 * `scripts/dev-window.ts` and any caller that already has a `ReviewWindowData`.
 */
export function openReviewWindowWithData(
	exec: Exec,
	data: ReviewWindowData,
	options: OpenReviewWindowOptions = {},
): OpenReviewWindowHandle {
	return openWindowInternal(exec, Promise.resolve(data), options);
}
