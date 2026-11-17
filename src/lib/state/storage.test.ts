/**
 * 存储这层：它承诺了什么，迁移做了什么。
 *
 * 这个环境里没有 IndexedDB，而这正是抽这层的原因——值得测的逻辑（把旧记录搬进 store、
 * 怎么算「已经存在」、写失败时旧数据原样保留）跟字符串和键有关，跟具体哪个数据库无关。
 */
import { describe, expect, it } from 'vitest';
import { memoryStore, migrateInto, type KeyValueStore } from './storage.js';

/** 一个可以按需让写入失败的 store，用来验证迁移失败不等于丢数据。 */
function failingStore(): KeyValueStore {
	const inner = memoryStore();
	return {
		...inner,
		async write(key, value) {
			if (key.startsWith('aetherax:project')) throw new Error('quota');
			await inner.write(key, value);
		}
	};
}

describe('migrateInto', () => {
	it('carries records the target does not have yet', async () => {
		const from = memoryStore();
		await from.write('aetherax:project', '{"version":3}');
		await from.write('aetherax:floorplan', 'data:image/png;base64,AAA');
		const to = memoryStore();

		expect(await migrateInto(to, ['aetherax:project', 'aetherax:floorplan'], from)).toBe(2);
		expect(await to.read('aetherax:project')).toBe('{"version":3}');
		// 旧的那份原样留着：这是复制不是移动，迁移之后出错也不会丢东西。
		expect(await from.read('aetherax:project')).toBe('{"version":3}');
	});

	it('never overwrites what the target already has', async () => {
		const from = memoryStore();
		await from.write('aetherax:project', 'legacy');
		const to = memoryStore();
		await to.write('aetherax:project', 'current');

		expect(await migrateInto(to, ['aetherax:project'], from)).toBe(0);
		expect(await to.read('aetherax:project')).toBe('current');
	});

	it('is idempotent, so it can run on every start', async () => {
		const from = memoryStore();
		await from.write('aetherax:project', 'legacy');
		const to = memoryStore();

		expect(await migrateInto(to, ['aetherax:project'], from)).toBe(1);
		expect(await migrateInto(to, ['aetherax:project'], from)).toBe(0);
	});

	it('leaves the source untouched when the target refuses the write', async () => {
		const from = memoryStore();
		await from.write('aetherax:project', 'legacy');
		const to = failingStore();

		await expect(migrateInto(to, ['aetherax:project'], from)).rejects.toThrow('quota');
		// 关键就在这：工程在原来那个 store 里仍然读得出来。
		expect(await from.read('aetherax:project')).toBe('legacy');
	});
});

describe('memoryStore', () => {
	it('behaves like a store: read, write, remove, keys', async () => {
		const store = memoryStore();
		expect(await store.read('missing')).toBeNull();
		await store.write('a', '1');
		await store.write('b', '2');
		expect((await store.keys()).sort()).toEqual(['a', 'b']);
		await store.remove('a');
		expect(await store.read('a')).toBeNull();
		expect(await store.keys()).toEqual(['b']);
	});
});
