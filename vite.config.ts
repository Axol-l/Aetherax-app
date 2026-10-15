import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
// @ts-expect-error type error without @types/node package
import process from 'node:process';

/**
 * The dev server Tauri expects, and the app's own test and worker settings.
 *
 * `tauri dev` runs this server itself and waits on `devUrl`, so the port is fixed and
 * must not fall back to another one: Tauri would sit waiting on 1420 while Vite served
 * 1421. `src-tauri` is ignored because the Rust build writes megabytes there and
 * nothing in the frontend imports it, and the screen is not cleared so a Rust compile
 * error stays readable.
 */
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
	plugins: [sveltekit()],
	test: {
		include: ['src/**/*.test.ts'],
		passWithNoTests: true
	},
	// The optimiser worker is a module worker; Vite has to emit it as one. `as const`
	// because this config is returned from a function, which widens the literal to
	// `string` and no longer matches Vite's own union.
	worker: {
		format: 'es' as const
	},
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || '127.0.0.1',
		hmr: host
			? {
					protocol: 'ws',
					host,
					port: 1421
				}
			: undefined,
		fs: {
			// The workspace packages are compiled from source, not from a build output.
			allow: ['..']
		},
		watch: {
			ignored: ['**/src-tauri/**'],
			// Editors that save atomically (write a temp dir/file, then rename) can make
			// the native file watcher throw EBUSY on the temp path. That error is emitted
			// on the FSWatcher rather than caught by Vite, so it takes the whole dev
			// server down. Polling does not watch those temp paths.
			usePolling: true
		}
	}
}));
