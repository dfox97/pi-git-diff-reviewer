import type { Exec } from "./types.js";
import { getMergeBase, getRepoRoot, hasHead, resolveBranch, runGit, runGitAllowFailure } from "./repo.js";
import {
	isReviewableFilePath,
	mergeChangedPaths,
	parseCommitLog,
	parseCommitLogWithNameStatus,
	parseNameStatus,
	parseTrackedPaths,
	parseUntrackedPaths,
	toComparison,
	toDisplayPath,
	uniquePaths,
	type ChangedPath,
} from "./parse.js";
import type { ReviewFile, ReviewFileComparison } from "../types.js";

export type { Exec, ExecOptions, ExecResult } from "./types.js";
export { getRepoRoot } from "./repo.js";
export { loadReviewFileContents, ReviewFileContentCache } from "./contents.js";

interface ReviewFileSeed {
	path: string;
	worktreeStatus: ReviewFileComparison["status"] | null;
	hasWorkingTreeFile: boolean;
	inGitDiff: boolean;
	inLastCommit: boolean;
	gitDiff: ReviewFileComparison | null;
	lastCommit: ReviewFileComparison | null;
	commitComparisons: Record<string, ReviewFileComparison>;
}

function buildReviewFileId(
	path: string,
	hasWorkingTreeFile: boolean,
	gitDiff: ReviewFileComparison | null,
	lastCommit: ReviewFileComparison | null,
): string {
	return [path, hasWorkingTreeFile ? "working" : "gone", gitDiff?.displayPath ?? "", lastCommit?.displayPath ?? ""].join("::");
}

function createReviewFile(seed: ReviewFileSeed): ReviewFile {
	return {
		id: buildReviewFileId(seed.path, seed.hasWorkingTreeFile, seed.gitDiff, seed.lastCommit),
		path: seed.path,
		worktreeStatus: seed.worktreeStatus,
		hasWorkingTreeFile: seed.hasWorkingTreeFile,
		inGitDiff: seed.inGitDiff,
		inLastCommit: seed.inLastCommit,
		gitDiff: seed.gitDiff,
		lastCommit: seed.lastCommit,
		commitComparisons: seed.commitComparisons,
	};
}

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
	return a.path.localeCompare(b.path);
}

function upsertSeed(seeds: Map<string, ReviewFileSeed>, key: string, create: () => ReviewFileSeed): ReviewFileSeed {
	const existing = seeds.get(key);
	if (existing != null) return existing;
	const seed = create();
	seeds.set(key, seed);
	return seed;
}

export interface ReviewWindowDataResult {
	repoRoot: string;
	files: ReviewFile[];
	commits: { sha: string; shortSha: string; subject: string }[];
	baseBranch?: string;
	mergeBase?: string;
}

/**
 * Build the full review window dataset. Uses one combined
 * `git log --name-status --format=…` invocation for the per-commit file index
 * (Q4-C) instead of a per-commit `diff-tree` spawn storm.
 */
export async function getReviewWindowData(
	exec: Exec,
	cwd: string,
	baseBranch?: string,
): Promise<ReviewWindowDataResult> {
	const repoRoot = await getRepoRoot(exec, cwd);
	const repositoryHasHead = await hasHead(exec, repoRoot);

	let mergeBase: string | undefined;
	if (baseBranch && repositoryHasHead) {
		const resolved = await resolveBranch(exec, repoRoot, baseBranch);
		if (resolved == null) {
			throw new Error(`Base branch "${baseBranch}" not found.`);
		}
		const base = await getMergeBase(exec, repoRoot, resolved);
		if (base == null) {
			throw new Error(`Could not find merge base between "${baseBranch}" and HEAD.`);
		}
		mergeBase = base;
	}

	// Working-tree diff (git diff) + untracked + ls-files + deleted, kept as-is.
	const trackedDiffOutput = repositoryHasHead
		? mergeBase != null
			? await runGit(exec, repoRoot, ["diff", "--find-renames", "-M", "--name-status", `${mergeBase}..HEAD`, "--"])
			: await runGit(exec, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
		: "";
	const untrackedOutput = mergeBase != null ? "" : await runGitAllowFailure(exec, repoRoot, ["ls-files", "--others", "--exclude-standard"]);
	const trackedFilesOutput = await runGitAllowFailure(exec, repoRoot, ["ls-files", "--cached"]);
	const deletedFilesOutput = mergeBase != null ? "" : await runGitAllowFailure(exec, repoRoot, ["ls-files", "--deleted"]);
	const lastCommitOutput = repositoryHasHead
		? await runGitAllowFailure(exec, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"])
		: "";

	// Combined commit log + per-commit name-status in one spawn (Q4-C).
	const commitLogOutput = repositoryHasHead
		? mergeBase != null
			? await runGitAllowFailure(exec, repoRoot, ["log", `${mergeBase}..HEAD`, "--max-count=50", "--name-status", "--format=%H%x09%h%x09%s"])
			: await runGitAllowFailure(exec, repoRoot, ["log", "--max-count=50", "--name-status", "--format=%H%x09%h%x09%s"])
		: "";
	const commitEntries = parseCommitLogWithNameStatus(commitLogOutput).map((entry) => ({
		sha: entry.sha,
		shortSha: entry.shortSha,
		subject: entry.subject,
		changes: entry.changes.filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "")),
	}));

	const commitChanges = new Map<string, ChangedPath[]>();
	for (const entry of commitEntries) {
		commitChanges.set(entry.sha, entry.changes);
	}
	const commits = commitEntries.map((entry) => ({ sha: entry.sha, shortSha: entry.shortSha, subject: entry.subject }));

	const worktreeChanges = mergeChangedPaths(parseNameStatus(trackedDiffOutput), parseUntrackedPaths(untrackedOutput))
		.filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
	const deletedPaths = new Set(parseTrackedPaths(deletedFilesOutput));
	const currentPaths = uniquePaths([...parseTrackedPaths(trackedFilesOutput), ...parseTrackedPaths(untrackedOutput)])
		.filter((path) => !deletedPaths.has(path))
		.filter(isReviewableFilePath);
	const lastCommitChanges = parseNameStatus(lastCommitOutput)
		.filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));

	const seeds = new Map<string, ReviewFileSeed>();

	for (const path of currentPaths) {
		seeds.set(path, {
			path,
			worktreeStatus: null,
			hasWorkingTreeFile: true,
			inGitDiff: false,
			inLastCommit: false,
			gitDiff: null,
			lastCommit: null,
			commitComparisons: {},
		});
	}

	for (const change of worktreeChanges) {
		const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
		const seed = upsertSeed(seeds, key, () => ({
			path: key,
			worktreeStatus: null,
			hasWorkingTreeFile: change.newPath != null,
			inGitDiff: false,
			inLastCommit: false,
			gitDiff: null,
			lastCommit: null,
			commitComparisons: {},
		}));
		seed.worktreeStatus = change.status;
		seed.hasWorkingTreeFile = change.newPath != null;
		seed.inGitDiff = true;
		seed.gitDiff = toComparison(change);
	}

	for (const change of lastCommitChanges) {
		const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
		const seed = upsertSeed(seeds, key, () => ({
			path: key,
			worktreeStatus: null,
			hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath),
			inGitDiff: false,
			inLastCommit: false,
			gitDiff: null,
			lastCommit: null,
			commitComparisons: {},
		}));
		seed.inLastCommit = true;
		seed.lastCommit = toComparison(change);
	}

	for (const [commitSha, changes] of commitChanges) {
		for (const change of changes) {
			const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
			const seed = upsertSeed(seeds, key, () => ({
				path: key,
				worktreeStatus: null,
				hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath),
				inGitDiff: false,
				inLastCommit: false,
				gitDiff: null,
				lastCommit: null,
				commitComparisons: {},
			}));
			seed.commitComparisons[commitSha] = toComparison(change);
		}
	}

	const files = [...seeds.values()].map(createReviewFile).sort(compareReviewFiles);

	return { repoRoot, files, commits, baseBranch, mergeBase };
}

// Keep parseCommitLog exported for callers that want just the commit list.
export { parseCommitLog } from "./parse.js";
