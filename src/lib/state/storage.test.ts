/**
 * The storage seam: what it promises, and what the migration does.
 *
 * There is no IndexedDB in this environment, which is the point of the seam — the logic
 * worth testing (carrying legacy records into a store, deciding what "already there"
 * means, leaving the old copy alone when a write fails) is about strings and keys rather
 * than about any particular database.
 */
import { describe, expect, it } from 'vitest';
import { memoryStore, migrateInto, type KeyValueStore } from './storage.js';

/** A store that can be told to fail, to check that a failed migration is not a loss. */
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
		// The legacy copy is left in place: this is a copy, not a move, so a failure after
		// the migration cannot be a loss.
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
		// The whole point: the project is still readable from the store that has it.
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
