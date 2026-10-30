import base from '@aetherax/eslint-config';
import tsParser from '@typescript-eslint/parser';
import sveltePlugin from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';

/**
 * The app's lint configuration.
 *
 * The TypeScript rules are the workspace packages' own config — `@aetherax/eslint-config` —
 * rather than a second copy of them. The two copies had already drifted (this one was
 * missing `consistent-type-imports`), and a rule added to the shared config is a rule the
 * app would never get.
 *
 * `.svelte.ts` files (every `$state` module) need no block of their own: they are plain
 * TypeScript and the shared `**\/*.ts` block covers them. They used to be routed through
 * the Svelte parser into a block with no `plugins` and no `rules`, so the state layer —
 * the largest modules in the app — was the one part of it with no rules applied at all.
 *
 * Only `.svelte` files need the Svelte parser, and only this file knows about it.
 */
export default [
	...base,
	{
		// Output and fixtures the shared config does not know about.
		ignores: ['**/build/**', '**/test-results/**', '**/playwright-report/**', 'static/**']
	},
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tsParser
			}
		},
		plugins: {
			svelte: sveltePlugin
		}
	},
	{
		/*
		 * Specs print the numbers they measure — `tests/measure` exists to be read in the
		 * console — so `no-console` has nothing to protect here. It stays on in `src/`,
		 * where the app's own output goes through `lib/log.ts`.
		 */
		files: ['tests/**/*.ts'],
		rules: {
			'no-console': 'off'
		}
	}
];
