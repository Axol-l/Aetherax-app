/// <reference types="vite/client" />
/**
 * Debug logging, on while developing and silent in a build.
 *
 * The app prints a lot of measured numbers — how long a save took, how long the
 * optimiser searched, how long a mask took to decode — and they are worth keeping: they
 * are how a regression in the expensive paths gets noticed. They are not worth shipping,
 * though: a desktop app should not write to a console the user never sees, and a browser
 * build should not either.
 *
 * So one helper, gated on Vite's `DEV`. **Use `debug` for measurements and diagnostics,
 * `console.warn`/`console.error` for things the user (or whoever reads a bug report) needs
 * to see in a release.** The lint rule allows exactly those two.
 *
 * The e2e suite runs against a **production** build and several specs detect a run's end
 * by counting the optimiser's own lines in the page console. `VITE_DEBUG_LOGS=1` at build
 * time keeps those lines on for that build only — it is set by `playwright.config.ts`'s
 * web server, never by `pnpm build` or `tauri build`. A test should prefer the DOM where
 * it can; this flag is for the ones that measure a run's progress.
 *
 * The `[scope]` prefix stays at the call site — `[save]`, `[optimizer]`, `[heatmap]` —
 * because a log line is read in the console next to others, not in this file.
 */
const enabled = import.meta.env.DEV || import.meta.env.VITE_DEBUG_LOGS === '1';

export function debug(...args: unknown[]): void {
	if (!enabled) return;
	// eslint-disable-next-line no-console -- this module is the one place that prints.
	console.info(...args);
}
