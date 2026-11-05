/**
 * 工程两次打开之间存在哪儿。
 *
 * 垫这一层是因为后端迟早要换：`localStorage` 只有约 5 MB，而一层楼的墙体掩码就是一张 PNG data URL，
 * 三层楼就快撑爆，满了以后工程重新加载回来会少东西。换成 IndexedDB 有几百 MB，写入也不必卡在主线程，
 * 所以接口**一律异步**——哪怕现在的实现不需要；以后再往调用方里补异步，正是这模块想避免的事。
 * 值统一是字符串：工程是 JSON，掩码是 data URL，这里不需要懂 blob 或 schema，那是 `persistence` 的事。
 */

export type StorageBackend = 'indexeddb' | 'localstorage';

export interface KeyValueStore {
	/** 这是哪种实现，用于可能要给用户看的提示。 */
	readonly backend: StorageBackend;
	read(key: string): Promise<string | null>;
	write(key: string, value: string): Promise<void>;
	/**
	 * 不返回 promise 的写入，只给那个等不了异步的调用方用。
	 *
	 * 正在关闭的窗口没机会跑完 promise 链：页面只剩一个同步回合，然后它就是没了。它存在就是为了
	 * 这个——见 `persistence.flushSaveSync`，也是唯一的调用方。
	 *
	 * 是可选项，因为不是每个后端都做得到。IndexedDB 就做不到：事务什么时候提交就什么时候提交，
	 * 没有同步写入。需要它的调用方得先检查有没有，不能想当然。
	 */
	writeSync?(key: string, value: string): void;
	remove(key: string): Promise<void>;
	/** 这个存储里的所有键，给迁移和工程列表用。 */
	keys(): Promise<string[]>;
}

/** 浏览器自带的存储，包成一个 store。 */
export const localStore: KeyValueStore = {
	backend: 'localstorage',
	async read(key) {
		return localStorage.getItem(key);
	},
	async write(key, value) {
		localStorage.setItem(key, value);
	},
	writeSync(key, value) {
		localStorage.setItem(key, value);
	},
	async remove(key) {
		localStorage.removeItem(key);
	},
	async keys() {
		const out: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key !== null) out.push(key);
		}
		return out;
	}
};

const DB_NAME = 'aetherax';
const STORE_NAME = 'kv';
const DB_VERSION = 1;

/**
 * 内存里的 store，给测试用，也给浏览器两种都不可用时兜底。
 *
 * 真实场景是无痕窗口禁用了存储：应用照常跑完这次会话并给出提示，而不是每次保存都抛错。
 */
export function memoryStore(): KeyValueStore {
	const map = new Map<string, string>();
	return {
		backend: 'localstorage',
		async read(key) {
			return map.get(key) ?? null;
		},
		async write(key, value) {
			map.set(key, value);
		},
		writeSync(key, value) {
			map.set(key, value);
		},
		async remove(key) {
			map.delete(key);
		},
		async keys() {
			return [...map.keys()];
		}
	};
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
	});
}

/** 用 IndexedDB 实现的 store：一个对象仓库，字符串键，字符串值。 */
export const indexDbStore: KeyValueStore = {
	backend: 'indexeddb',
	async read(key) {
		const db = await openDatabase();
		try {
			return await new Promise<string | null>((resolve, reject) => {
				const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
				request.onsuccess = () => resolve((request.result as string | undefined) ?? null);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	},
	async write(key, value) {
		const db = await openDatabase();
		try {
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(STORE_NAME, 'readwrite');
				tx.objectStore(STORE_NAME).put(value, key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error ?? new Error('write aborted'));
			});
		} finally {
			db.close();
		}
	},
	async remove(key) {
		const db = await openDatabase();
		try {
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(STORE_NAME, 'readwrite');
				tx.objectStore(STORE_NAME).delete(key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		} finally {
			db.close();
		}
	},
	async keys() {
		const db = await openDatabase();
		try {
			return await new Promise<string[]>((resolve, reject) => {
				const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys();
				request.onsuccess = () => resolve((request.result as IDBValidKey[]).map(String));
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	}
};

/**
 * 把只存在于 localStorage 里的记录搬进 `store`。
 *
 * 每次启动都跑，且幂等：目标里已经有这个键就跳过。所以这是复制不是移动，旧数据在写入
 * 确认落地之前一直留着，由调用方之后自己一次性删掉。
 *
 * 返回搬过去多少个键。
 */
export async function migrateInto(
	store: KeyValueStore,
	keys: readonly string[],
	from: KeyValueStore = localStore
): Promise<number> {
	let moved = 0;
	for (const key of keys) {
		const existing = await store.read(key);
		if (existing !== null) continue;
		const legacy = await from.read(key);
		if (legacy === null) continue;
		await store.write(key, legacy);
		moved++;
	}
	return moved;
}
