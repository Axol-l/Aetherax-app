import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
	clearSavedState,
	flushSaveSync,
	forgetFloorplan,
	restoreFromStorage,
	saveNow,
	scheduleSave
} from './persistence.svelte.js';
import { appState } from './app.svelte.js';
import { DOCUMENT_VERSION } from './project-document.js';

/*
 * The save path, against a `localStorage` this file controls.
 *
 * There is no jsdom here, so the browser's storage is a `Map` with the four members the
 * app uses. That is enough for everything these tests are about — *when* a write happens,
 * which keys it touches, and what survives a clear — because none of it depends on a real
 * DOM. The one path that does (encoding an imported plan through an `<img>`) is covered by
 * the e2e suite instead.
 */

const PROJECT_KEY = 'aetherax:project';
const FLOORPLAN_KEY = 'aetherax:floorplan';

function installStorage(): Map<string, string> {
	const data = new Map<string, string>();
	const storage = {
		get length() {
			return data.size;
		},
		key: (index: number) => [...data.keys()][index] ?? null,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		removeItem: (key: string) => {
			data.delete(key);
		},
		clear: () => {
			data.clear();
		}
	};
	(globalThis as unknown as { localStorage: Storage }).localStorage = storage as Storage;
	return data;
}

describe('persistence', () => {
	let storage: Map<string, string>;

	beforeEach(async () => {
		vi.useFakeTimers();
		storage = installStorage();
		/*
		 * Start with nothing pending. `savePending` outlives a test — it is cleared by a
		 * successful write and by nothing else — so each test begins by earning that
		 * clean state the way the app does, with one full save.
		 */
		await saveNow();
		storage.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('flushSaveSync', () => {
		it('writes the project while a save is still waiting for its debounce', () => {
			scheduleSave();

			expect(flushSaveSync()).toBe(true);
			expect(storage.get(PROJECT_KEY)).toContain('"floors"');
		});

		it('does nothing when there is nothing to write', () => {
			// Nothing was scheduled since the last successful save.
			expect(flushSaveSync()).toBe(false);
			expect(storage.has(PROJECT_KEY)).toBe(false);
		});

		it('leaves the debounced save armed, because it still owns the underlays', () => {
			const timersBefore = vi.getTimerCount();
			scheduleSave();
			flushSaveSync();

			// The synchronous write covers the document only: an underlay has to be decoded
			// and encoded through an `<img>`, which cannot happen in the page's last turn.
			// Cancelling the timer here would leave an imported plan that never reaches
			// storage, so the normal save has to stay on the books.
			expect(vi.getTimerCount()).toBe(timersBefore + 1);
		});
	});

	describe('clearSavedState', () => {
		it('removes the project and every per-floor underlay, not just the current floor', () => {
			storage.set(PROJECT_KEY, '{}');
			storage.set(FLOORPLAN_KEY, 'legacy');
			storage.set(`${FLOORPLAN_KEY}:floor-a`, 'a');
			storage.set(`${FLOORPLAN_KEY}:floor-b`, 'b');

			return clearSavedState().then(() => {
				expect(storage.has(PROJECT_KEY)).toBe(false);
				expect(storage.has(FLOORPLAN_KEY)).toBe(false);
				expect(storage.has(`${FLOORPLAN_KEY}:floor-a`)).toBe(false);
				expect(storage.has(`${FLOORPLAN_KEY}:floor-b`)).toBe(false);
			});
		});

		it('leaves records it does not own alone', async () => {
			storage.set('somebody:elses:key', 'keep me');

			await clearSavedState();

			expect(storage.get('somebody:elses:key')).toBe('keep me');
		});
	});

	describe('forgetFloorplan', () => {
		it("drops one floor's underlay and leaves the other floors' alone", async () => {
			storage.set(`${FLOORPLAN_KEY}:gone`, 'x');
			storage.set(`${FLOORPLAN_KEY}:stays`, 'y');

			await forgetFloorplan('gone');

			expect(storage.has(`${FLOORPLAN_KEY}:gone`)).toBe(false);
			expect(storage.get(`${FLOORPLAN_KEY}:stays`)).toBe('y');
		});
	});

	/*
	 * What restore does with a record it cannot use.
	 *
	 * "Cannot read" and "written by a newer build" look the same to `migrate` and must not act
	 * the same: one is rubbish, the other is the user's project. Deleting the second is the only
	 * way the app can destroy work it never opened.
	 */
	describe('restoreFromStorage', () => {
		it('keeps a document from a newer version, and says why nothing loaded', async () => {
			const newer = JSON.stringify({ version: DOCUMENT_VERSION + 1, name: 'future', floors: [] });
			storage.set(PROJECT_KEY, newer);

			await expect(restoreFromStorage()).resolves.toBe(false);

			expect(storage.get(PROJECT_KEY)).toBe(newer);
			expect(appState.storageNotice).toMatch(/newer version/);
		});

		it('removes a record it cannot read at all', async () => {
			storage.set(PROJECT_KEY, JSON.stringify({ version: DOCUMENT_VERSION }));

			await expect(restoreFromStorage()).resolves.toBe(false);

			expect(storage.has(PROJECT_KEY)).toBe(false);
		});
	});
});
