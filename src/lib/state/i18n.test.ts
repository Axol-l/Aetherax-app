/**
 * The catalogue is hand-written and the interface is large, so check it against the source
 * rather than trusting it: an untranslated key silently falls back to English, which is the
 * right behaviour at runtime and invisible in review.
 *
 * The sources come in through Vite (`?raw`), so this needs no Node types in a browser tsconfig.
 */
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('../../**/*.{svelte,ts}', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/** The catalogue itself, and the files that only talk about keys. */
const isCatalogue = (path: string) => path.endsWith('/i18n.svelte.ts');
const isTest = (path: string) => /\.(test|spec)\.ts$/.test(path) || path.endsWith('.d.ts');

/** Keys passed to `t('...')`, unescaped the way the runtime reads them. */
function usedKeys(): string[] {
	const keys: string[] = [];
	for (const [path, src] of Object.entries(sources)) {
		if (isCatalogue(path) || isTest(path)) continue;
		for (const m of src.matchAll(/(?:^|[^\w$.])t\(\s*'((?:[^'\\]|\\.)*)'/g)) {
			keys.push(m[1]!.replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
		}
	}
	return keys;
}

/** Keys of the `zh` catalogue, including entries whose value sits on the next line. */
function catalogueKeys(): string[] {
	const entry = Object.entries(sources).find(([path]) => isCatalogue(path));
	if (!entry) throw new Error('catalogue not found');
	const keys: string[] = [];
	for (const m of entry[1].matchAll(/^\t(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*)):\s/gm)) {
		keys.push(m[1] !== undefined ? m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\') : m[2]!);
	}
	return keys;
}

describe('translation catalogue', () => {
	it('covers every key the interface uses', () => {
		const catalogue = new Set(catalogueKeys());
		const missing = [...new Set(usedKeys())].filter((key) => !catalogue.has(key)).sort();
		expect(missing).toEqual([]);
	});

	it('has no duplicate entries', () => {
		const keys = catalogueKeys();
		expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
	});

	it('reads a plausible slice of the interface', () => {
		expect(Object.keys(sources).length).toBeGreaterThan(20);
		expect(usedKeys().length).toBeGreaterThan(150);
	});
});