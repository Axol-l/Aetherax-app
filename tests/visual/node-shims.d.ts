/**
 * The handful of Node APIs this spec needs, declared locally.
 *
 * `apps/web` is browser code and its tsconfig carries no `@types/node` — the e2e
 * specs avoid Node builtins for exactly that reason. A golden-image test cannot:
 * reading and writing the baseline files on disk has no browser equivalent, and
 * `svelte-check` typechecks this directory along with the app.
 *
 * Adding `@types/node` to the web app would type the entire project against Node's
 * globals to satisfy five call sites. Declaring only what is used keeps the surface
 * visible and the rest of the app browser-only. **If this outgrows a couple of
 * functions, add the dependency instead** — a hand-kept shim that keeps growing is
 * a worse trade than the types package.
 */
declare module 'node:fs' {
	export function existsSync(path: string): boolean;
	export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
	/** With an encoding: the callers that want text (a fixture SVG). */
	export function readFileSync(path: string, encoding: string): string;
	/** Without one: the callers that want bytes (a golden PNG). */
	export function readFileSync(path: string): { toString(encoding: string): string };
	export function writeFileSync(path: string, data: Uint8Array | string): void;
}

declare module 'node:path' {
	export function join(...parts: string[]): string;
}

declare const process: { env: Record<string, string | undefined> };
declare const Buffer: {
	from(data: string, encoding: string): Uint8Array;
	/** Playwright's `screenshot()` returns one of these; comparing two is how a test asks "did the canvas change". */
	compare(a: Uint8Array, b: Uint8Array): number;
};
