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
	},
	{
		/*
		 * The layer rule `docs/ARCHITECTURE.md` states, enforced rather than described.
		 *
		 * `rf/` is the model: no DOM, no `$state`, no components. It used to import the wall
		 * material table and the room types out of `canvas/`, which is how a rendering folder
		 * became a dependency of the physics — and nothing said so, because the rule was one
		 * sentence in a document. Both tables live in `domain/` now, so importing anything that
		 * draws from below it is a lint error rather than a review comment.
		 */
		files: ['src/lib/rf/**/*.ts', 'src/lib/domain/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: [
								'**/canvas/*',
								'$canvas/*',
								'**/state/*',
								'$state/*',
								'**/components/*',
								'$components/*'
							],
							message:
								'rf/ and domain/ sit below the app: import from domain/ or rf/, not from the layers that draw.'
						}
					]
				}
			]
		}
	}
];
