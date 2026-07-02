import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isWSL } from "./wsl-glimpse.js";

/**
 * Absolute on-disk path to the packaged `web/` directory.
 *
 * Works in both source (`src/...`) and built (`dist/...`) layouts because this
 * module lives at `<pkgroot>/<src|dist>/platform/resolve-web-dir.ts` — two
 * levels below the package root, where `web/` always resides.
 */
export function resolveWebDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const webDir = join(here, "..", "..", "web");
	if (!existsSync(webDir)) {
		throw new Error(`Could not locate packaged web/ directory at ${webDir}`);
	}
	return webDir;
}

function toWindowsUncPath(posixPath: string): string {
	const distro = process.env.WSL_DISTRO_NAME;
	if (distro == null || distro.length === 0) {
		// Without the distro name we cannot form a UNC path the Windows WebView2
		// can resolve. Fall back to copying via the /mnt/c temp area is not done
		// here; callers should handle the thrown error by copying instead.
		throw new Error(
			"WSL_DISTRO_NAME is not set; cannot resolve a Windows-accessible path for the review window. Set WSL_DISTRO_NAME or run outside WSL.",
		);
	}
	// posixPath is an absolute Linux path like /home/user/project/web/index.html.
	const rest = posixPath.replace(/^\//, "").replace(/\//g, "\\");
	return `\\\\wsl.localhost\\${distro}\\${rest}`;
}

/**
 * Returns a filesystem path that the native webview's `loadFile` can navigate
 * to for a file inside the packaged `web/` directory. On WSL the web/ directory
 * lives in the Linux filesystem, so we hand back a `\\wsl.localhost\<distro>\…`
 * UNC path that the Windows WebView2 can resolve (and against which relative
 * `./app.js` / `./vendor/…` refs resolve). On macOS/Linux we return the plain
 * absolute path.
 *
 * `relativePath` is relative to `web/` (e.g. `"index.html"`).
 */
export function resolveLoadFilePath(relativePath: string): string {
	const abs = join(resolveWebDir(), relativePath);
	if (isWSL()) {
		return toWindowsUncPath(abs);
	}
	return abs;
}
