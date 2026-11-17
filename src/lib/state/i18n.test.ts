/**
 * 译文表是手写的、界面又大，所以拿源码对一遍，别直接信它。
 *
 * 漏翻的键运行时只会悄悄回退成英文，看着没错，评审时也看不出来。
 *
 * 源码用 Vite 的 `?raw` 读进来，这样浏览器版 tsconfig 里不用引 Node 类型。
 */
import { describe, expect, it } from 'vitest';
import { FLOOR_MATERIALS } from '../canvas/floor-materials.js';

const sources = import.meta.glob('../../**/*.{svelte,ts}', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/** 译文表本身，以及只提到键名、不该参与统计的文件。 */
const isCatalogue = (path: string) => path.endsWith('/i18n.svelte.ts');
const isTest = (path: string) => /\.(test|spec)\.ts$/.test(path) || path.endsWith('.d.ts');

/** 传给 `t('...')` 的键，按运行时的方式把转义还原。 */
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

/** `zh` 表里的键，也包括值写在下一行的那种条目。 */
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

	it('covers the floor material names the picker translates at runtime', () => {
		// 材质选择器是运行时调 `t(material.name)`，上面的扫描看不见这些键：
		// 漏一条就会让那个选项一直显示英文。
		const catalogue = new Set(catalogueKeys());
		const missing = FLOOR_MATERIALS.map((material) => material.name).filter(
			(name) => !catalogue.has(name)
		);
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