import type { Exec as ExecType } from "./types.js";

// Re-export the Exec shape so callers can `import type { Exec } from "../repo.js"`.
export type { Exec, ExecOptions, ExecResult } from "./types.js";

// ---- Tiny shared Exec contract -------------------------------------------
// (Kept in its own file `git/types.ts` so parse.ts and contents.ts can import
// the shape without pulling in the repo-resolution logic.)

export async function runGit(exec: ExecType, repoRoot: string, args: string[]): Promise<string> {
	const result = await exec("git", args, { cwd: repoRoot });
	if (result.code !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

export async function runGitAllowFailure(exec: ExecType, repoRoot: string, args: string[]): Promise<string> {
	const result = await exec("git", args, { cwd: repoRoot });
	if (result.code !== 0) return "";
	return result.stdout;
}

export async function getRepoRoot(exec: ExecType, cwd: string): Promise<string> {
	const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) {
		throw new Error("Not inside a git repository.");
	}
	return result.stdout.trim();
}

export async function hasHead(exec: ExecType, repoRoot: string): Promise<boolean> {
	const result = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
	return result.code === 0;
}

export async function resolveBranch(exec: ExecType, repoRoot: string, branch: string): Promise<string | null> {
	const candidates = branch.includes("/") ? [branch] : [branch, `origin/${branch}`];
	for (const candidate of candidates) {
		const result = await exec("git", ["rev-parse", "--verify", candidate], { cwd: repoRoot });
		if (result.code !== 0) continue;
		const sha = result.stdout.trim();
		if (sha.length > 0) return sha;
	}
	return null;
}

export async function getMergeBase(exec: ExecType, repoRoot: string, baseBranch: string): Promise<string | null> {
	const result = await exec("git", ["merge-base", baseBranch, "HEAD"], { cwd: repoRoot });
	if (result.code !== 0) return null;
	const sha = result.stdout.trim();
	return sha.length > 0 ? sha : null;
}
