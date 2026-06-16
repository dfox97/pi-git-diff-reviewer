/**
 * opencode plugin entry. opencode scans `.opencode/plugins/` for TypeScript
 * files and treats every exported function as a plugin. This file is the
 * thin entry the loader sees; the actual binding logic lives in
 * `../../src/bindings/opencode.ts` so that:
 *
 *   - The pi extension path (`src/bindings/pi.ts`) and the opencode binding
 *     stay symmetric and easy to compare.
 *   - The agent-agnostic core in `src/core/` is the only place that owns
 *     the diff-review domain; the binding is just glue.
 *
 * Bun (opencode's runtime) resolves `../../src/bindings/opencode.js` to
 * `../../src/bindings/opencode.ts` automatically.
 */

export { DiffReviewPlugin } from "../../src/bindings/opencode.js";
