/**
 * 工程两次打开之间存在哪儿。
 
 */

export type StorageBackend = 'indexeddb' | 'localstorage';

export interface KeyValueStore {
	/** 这是哪种实现，用于可能要给用户看的提示。 */
	readonly backend: StorageBackend;
	read(key: string): Promise<string | null>;
	write(key: string, value: string): Promise<void>;
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
