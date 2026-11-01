/**
 * Where a project lives between sessions.
 *
 * One seam, so that changing the backend is a change in one place rather than a rewrite
 * of the save path. It exists because the backend has to change: `localStorage` gives the
 * app about five megabytes, and a floor's wall mask is a PNG data URL, so a three-storey
 * plan is already within sight of the quota — the failure mode being a project that comes
 * back short after a reload.
 *
 * IndexedDB is the replacement: hundreds of megabytes rather than five, and writes that
 * do not have to happen on the main thread's critical path. The interface is therefore
 * **asynchronous** even though the localStorage implementation is not, because retrofitting
 * async onto the callers later is exactly the kind of change this module is meant to avoid.
 *
 * Values are strings. The project document is JSON and the masks are data URLs, so nothing
 * here needs to know what a blob or a schema is — that belongs to `persistence`.
 */

export type StorageBackend = 'indexeddb' | 'localstorage';

export interface KeyValueStore {
	/** Which implementation this is, for the notice the user may have to read. */
	readonly backend: StorageBackend;
	read(key: string): Promise<string | null>;
	write(key: string, value: string): Promise<void>;
	/**
	 * Write without handing back a promise, for the one caller that cannot await.
	 *
	 * A window that is being destroyed does not get to finish a promise chain: the page
	 * gets one synchronous turn and then it is gone. That is the whole reason this exists
	 * — see `persistence.flushSaveSync`, which is its only caller.
	 *
	 * Optional, because a backend may not be able to honour it. IndexedDB cannot: its
	 * transaction commits when it commits, and there is no synchronous write. A caller
	 * that needs one has to check for it instead of assuming.
	 */
	writeSync?(key: string, value: string): void;
	remove(key: string): Promise<void>;
	/** Every key this store holds, for migration and for a project list. */
	keys(): Promise<string[]>;
}

/** The browser's own storage, as a store. */
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
 * An in-memory store, for tests and for the one case where the browser has neither.
 *
 * A private window with storage disabled is the real case: the app then keeps working for
 * the session and says so, rather than throwing on every save.
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

/** IndexedDB as a store. One object store, string keys, string values. */
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
 * Move records that only exist in localStorage into `store`.
 *
 * Runs on every start and is idempotent: a key already present in the target is left
 * alone, so this is a copy rather than a move and the old copy stays until the write is
 * known to have landed. Callers remove the legacy keys afterwards, once, deliberately.
 *
 * Returns how many keys were carried over.
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
