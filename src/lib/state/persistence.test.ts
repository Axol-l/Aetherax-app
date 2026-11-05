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
 * 本地存储的保存流程，用本文件自己控制的 `localStorage` 来测。
 *
 * 这里没有 jsdom，所以用 `Map` 加应用真正用到的四个成员冒充浏览器存储。测的都是
 * 「什么时候写、写到哪些键、清空后还剩什么」，这些跟真 DOM 无关。唯一要真 DOM 的路径
 * （用 `<img>` 编码导入的图纸）放在 e2e 里测。
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
		 * 先保证没有待写的改动。`savePending` 会跨测试留着——只有成功写入才会清掉它——
		 * 所以每个测试开头都像应用启动那样做一次完整保存，把这个干净状态挣回来。
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
			// 上次保存成功后没再排过新任务。
			expect(flushSaveSync()).toBe(false);
			expect(storage.has(PROJECT_KEY)).toBe(false);
		});

		it('leaves the debounced save armed, because it still owns the underlays', () => {
			const timersBefore = vi.getTimerCount();
			scheduleSave();
			flushSaveSync();

			// 同步写只覆盖工程文档：底图要经 `<img>` 解码再编码，页面最后一刻做不完。
			// 这里把定时器取消掉，导入的图纸就永远进不了存储，所以正常保存必须留着。
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
	 * 恢复时碰上一条用不了的记录，该怎么处理。
	 *
	 * 「读不出来」和「更新版本写的」在 `migrate` 眼里长得一样，但处理绝不能一样：
	 * 前者是垃圾，后者是用户的项目。删掉后者，就是应用唯一可能毁掉一份从没打开过的工作的方式。
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
