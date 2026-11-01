import { debug } from '$lib/log.js';
import { floorCoverage as floorCoverageState } from './optimizer.svelte.js';
import { floorState, onFloorRemoved } from './floor-state.svelte.js';
import { appState } from './app.svelte.js';
import { t } from './i18n.svelte.js';
import { applyDocument, isFromNewerVersion, migrate, toDocument } from './project-document.js';
import {
	indexDbStore,
	localStore,
	migrateInto,
	type KeyValueStore,
	type StorageBackend
} from './storage.js';

/**
 * Every key this app writes starts with this. Exported because `WelcomeDialog` has to
 * consult the same prefix before the app restores anything.
 */
export const STORAGE_PREFIX = 'aetherax:';
/** The prefix the app carried before it was renamed. Read-only, and never written. */
const LEGACY_PREFIX = 'deconflict:';

const STORAGE_KEY = `${STORAGE_PREFIX}project`;
const FLOORPLAN_KEY = `${STORAGE_PREFIX}floorplan`;
/**
 * How long after the last edit an autosave runs.
 *
 * Two seconds is short enough that a drag or a run of wall edits finishes *inside* the
 * window and still triggers a write while the user is looking at the result: every snapshot
 * serialises every floor's mask data URLs, which is megabytes. Five seconds means one write
 * after a gesture instead of one during it, and nothing is lost — the delay is only the gap
 * between "the plan changed" and "the plan is on disk".
 */
const SAVE_DELAY = 5000;

/**
 * The key a floor's underlay is stored under.
 *
 * One function, because the same string used to be built by hand in three places — the
 * write, the restore and the clear — and the per-floor form is exactly the one the
 * migration that runs at startup swept for by *name* and therefore missed. Switching the
 * backend moved the project document and left every underlay behind.
 */
const floorplanKey = (floorId: string) => `${FLOORPLAN_KEY}:${floorId}`;

/**
 * The underlay URL each floor has already had encoded and written, by floor id.
 *
 * A floor's `floorplanUrl` is a `blob:` URL from the moment it is imported until the page
 * reloads, so "does this floor still need writing?" cannot be answered from the floor —
 * the save path used to re-encode and re-write every imported plan on *every* autosave,
 * a `canvas.toDataURL` of a multi-megabyte image per floor every five seconds. Comparing
 * the URL remembers the answer for as long as the image is the same one.
 */
const encodedUnderlays = new Map<string, string>();

/**
 * Whether an edit is still on its way to storage.
 *
 * Distinct from `saveTimeout`, which only says a timer is armed: the debounce can already
 * have fired, and the write it started can still be in flight. The unload flush is only
 * worth doing when one of the two is true.
 */
let savePending = false;

/**
 * Copy every stored key from the old prefix to the new one, once.
 *
 * A prefix sweep rather than a list of keys, because per-floor floorplans are stored as
 * `<prefix>floorplan:<floorId>` — one key per floor, with ids that only exist at runtime.
 * Nothing is deleted, so a rollback to the previous build still finds the project, and an
 * existing key under the new prefix is never overwritten.
 *
 * Safe to call more than once and safe to call before anything else has run: it only
 * copies, and a failure to reach localStorage leaves the app working, just forgetful.
 */
export function migrateLegacyStorageKeys(): void {
	try {
		const moves: Array<[string, string]> = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key && key.startsWith(LEGACY_PREFIX)) {
				moves.push([key, STORAGE_PREFIX + key.slice(LEGACY_PREFIX.length)]);
			}
		}
		for (const [oldKey, newKey] of moves) {
			if (localStorage.getItem(newKey) !== null) continue;
			const value = localStorage.getItem(oldKey);
			if (value !== null) localStorage.setItem(newKey, value);
		}
	} catch {
		// Private mode or a full quota: the app still runs, it just starts fresh.
	}
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
export const persistenceState = $state({ lastSaved: null as Date | null });

/**
 * Write the project to whichever store is in use.
 *
 * Asynchronous because the backend is: IndexedDB, with localStorage as the fallback for a
 * browser that has none (see `state/storage.ts`). The debounced caller fires and forgets —
 * a failure is not silent, it lands in `appState.storageNotice`, which is the whole point
 * of the notice: with a five-megabyte quota and a PNG mask per floor, "saved nothing and
 * said nothing" is the failure mode that loses work.
 *
 * The document itself is built by `project-document.ts`, which is also what a file export
 * and an import go through. This function only decides *where* it goes and what to say when
 * it cannot.
 */
async function saveToStorage(): Promise<void> {
	/*
	 * The timer has fired, so nothing is pending any more.
	 *
	 * Leaving the handle set made every later `scheduleSave(true)` return early
	 * forever — the `keep` callers thought a save was on its way and no save was
	 * ever scheduled again, so an access point's mounting (and anything else that
	 * only ever asks for `keep`) reached storage once and never again.
	 */
	if (saveTimeout) clearTimeout(saveTimeout);
	saveTimeout = null;

	const store = await ensureStore();
	try {
		const started = performance.now();
		const json = JSON.stringify(toDocument({ floorCoverage: floorCoverageState }));
		// Timed and reported: a write that takes seconds is a stall in the middle of the
		// user's work, and the only way to know is to print it.
		debug(
			`[save] ${json.length} bytes serialised in ${Math.round(performance.now() - started)} ms`
		);
		await store.write(STORAGE_KEY, json);

		/*
		 * The underlays are part of this save, not a fire-and-forget afterthought.
		 *
		 * They used to be written from an `img.onload` callback whose failure went into an
		 * empty `.catch`, while `lastSaved` and the save notice had already been set from
		 * the document alone — so the app could tell the user "Project saved" and then come
		 * back next session with a floor whose plan is missing. Now a failed underlay
		 * write fails the save and lands in `storageNotice` like any other.
		 */
		await writeUnderlays(store);

		debug(`[save] written in ${Math.round(performance.now() - started)} ms`);
		persistenceState.lastSaved = new Date();
		savePending = false;
		// A later save that works clears the warning: storage was full, and is not any
		// more.
		appState.storageNotice = null;
	} catch {
		appState.storageNotice = t(
			'The project could not be saved: the browser storage is full or unavailable. Export it to a file (File → Export JSON), then remove a floorplan or a floor to make room.'
		);
	}
}

/**
 * Write every underlay that is not on disk yet.
 *
 * A plan arrives as a `blob:` URL and has to be a data URL to be stored. Only floors still
 * holding a blob are looked at, and only once per image: see `encodedUnderlays`.
 */
async function writeUnderlays(store: KeyValueStore): Promise<void> {
	const writes: Array<Promise<void>> = [];
	for (const floor of floorState.floors) {
		const url = floor.floorplanUrl;
		if (!url || !url.startsWith('blob:')) continue;
		if (encodedUnderlays.get(floor.id) === url) continue;
		writes.push(
			encodeUnderlay(url).then(async (dataUrl) => {
				await store.write(floorplanKey(floor.id), dataUrl);
				encodedUnderlays.set(floor.id, url);
			})
		);
	}
	await Promise.all(writes);
}

/** A floorplan image URL as a data URL, for storage. */
function encodeUnderlay(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onerror = () => reject(new Error('the floorplan image could not be decoded'));
		image.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				reject(new Error('the floorplan image could not be encoded'));
				return;
			}
			ctx.drawImage(image, 0, 0);
			resolve(canvas.toDataURL('image/png'));
		};
		image.src = url;
	});
}

/**
 * Which store the project is kept in.
 *
 * `localstorage` today, on purpose, and the seam exists so that turning the other one on
 * is a one-line change rather than a rewrite. The reason it is still the old one: every
 * test helper that asks "what did the app save?" reads `localStorage`, and so may any tool
 * a user has around their projects. Moving the project into IndexedDB therefore has to
 * move those readers with it, and that is a change of its own — measured, not assumed.
 * `indexeddb` is implemented and unit-tested behind this switch; see `state/storage.ts`
 * for why it is the destination (a five-megabyte quota against a PNG mask per floor).
 */
const BACKEND: StorageBackend = 'localstorage';

/**
 * The store the project is kept in, opened once.
 *
 * Whichever backend is selected, any record that only exists in localStorage is carried
 * over first, so a project saved by an older build is found by this one.
 */
let projectStore: KeyValueStore | null = null;
async function ensureStore(): Promise<KeyValueStore> {
	if (projectStore) return projectStore;
	let store: KeyValueStore = localStore;
	if (BACKEND === 'indexeddb') {
		try {
			// A round trip rather than a feature test: a private window can expose
			// `indexedDB` and refuse to open a database.
			await indexDbStore.keys();
			store = indexDbStore;
		} catch {
			store = localStore;
		}
	}
	try {
		await migrateInto(store, await legacyRecordKeys(store));
	} catch {
		// The legacy copy is still there and still readable: carry on with what we have
		// rather than starting the app with no project at all.
	}
	projectStore = store;
	return store;
}

/**
 * Every record an older build left in `localStorage` that this store should carry over.
 *
 * Enumerated by prefix rather than listed, because the underlays are keyed
 * `floorplan:<floorId>` and the ids only exist at runtime: naming the two fixed keys was
 * exactly how a switch of backend moved the project document and dropped every floor's
 * plan on the floor.
 */
async function legacyRecordKeys(store: KeyValueStore): Promise<string[]> {
	// Nothing to carry over into the store that already holds everything.
	if (store.backend === 'localstorage') return [];
	const keys = await localStore.keys();
	return keys.filter(
		(key) => key === STORAGE_KEY || key === FLOORPLAN_KEY || key.startsWith(`${FLOORPLAN_KEY}:`)
	);
}

/** Which backend the project is in, for the storage notice. Exported for diagnostics. */
export function storageBackend(): StorageBackend | null {
	return projectStore?.backend ?? null;
}

export async function restoreFromStorage(): Promise<boolean> {
	// First thing: a project saved before the rename lives under the old prefix, and that
	// is a localStorage concern — it runs before anything is read.
	migrateLegacyStorageKeys();
	const store = await ensureStore();
	try {
		const raw = await store.read(STORAGE_KEY);
		if (!raw) return false;

		/*
		 * A document from a newer build is kept, not removed.
		 *
		 * `migrate` cannot read it — it does not know the fields — and rewriting it would drop
		 * them. Removing it, which is what the corrupt case does, would turn "this build cannot
		 * open your project" into "your project is gone", so the record stays exactly where it is
		 * and the notice says why nothing loaded.
		 */
		const parsed: unknown = JSON.parse(raw);
		if (isFromNewerVersion(parsed)) {
			appState.storageNotice = t(
				'This project was saved by a newer version of the app. It has been left untouched — update the app to open it.'
			);
			return false;
		}

		const doc = migrate(parsed);
		if (!doc) {
			await store.remove(STORAGE_KEY);
			await store.remove(FLOORPLAN_KEY);
			return false;
		}

		/*
		 * The underlays live under their own keys, one per floor, and are read back into
		 * the document before it is applied — so a floor's image arrives with the floor
		 * rather than being patched on afterwards. The old single key is the version 2
		 * format's, kept for the one project that still has it.
		 */
		for (const floor of doc.floors) {
			const perFloor = await store.read(floorplanKey(floor.id));
			if (perFloor) floor.floorplanImage = perFloor;
		}
		if (!doc.floors[0]!.floorplanImage) {
			const legacyFloorplan = await store.read(FLOORPLAN_KEY);
			if (legacyFloorplan) doc.floors[0]!.floorplanImage = legacyFloorplan;
		}

		// The undo history is cleared by `applyDocument`, which is the door every load goes
		// through — see the note there.
		applyDocument(doc, { floorCoverage: floorCoverageState });
		return true;
	} catch {
		return false;
	}
}

/**
 * Forget everything this app has stored: the project and every floor's underlay.
 *
 * Enumerated by prefix rather than by the app's own key list, because the keys that
 * outlive a floor are the ones nobody is holding: a floor that has been removed is gone
 * from `floorState.floors` and its underlay is still there, taking megabytes out of a
 * five-megabyte quota, with no code path left that would ever delete it.
 */
export async function clearSavedState(): Promise<void> {
	const store = await ensureStore();
	for (const key of await store.keys()) {
		if (key === STORAGE_KEY || key === FLOORPLAN_KEY || key.startsWith(`${FLOORPLAN_KEY}:`)) {
			await store.remove(key);
		}
	}
	encodedUnderlays.clear();
	persistenceState.lastSaved = null;
}

/**
 * Drop one floor's stored underlay, because the floor it belonged to is gone.
 *
 * Separate from `clearSavedState` because removing a floor is not removing the project,
 * and the caller is the one that knows both (see `FloorStrip`); keeping the delete here
 * is what stops the key scheme from being spelled a fourth time.
 */
export async function forgetFloorplan(floorId: string): Promise<void> {
	encodedUnderlays.delete(floorId);
	const store = await ensureStore();
	try {
		await store.remove(floorplanKey(floorId));
	} catch {
		// A store that cannot delete the record is not a reason to refuse the floor
		// removal that has already happened in memory.
	}
}
/*
 * A floor that goes away takes its underlay with it.
 *
 * Registered rather than called from the UI: the storage keys are this module's business, and a
 * caller remembering to ask is a caller that eventually does not. `floor-state` cannot import this
 * module (this one reads it), so it calls back instead.
 */
onFloorRemoved((floorId) => void forgetFloorplan(floorId));

/**
 * Save now, because the user asked — and say so.
 *
 * The debounced `scheduleSave` is right for an edit and wrong for a keystroke or a menu
 * click: the user is watching for an answer, and a save that happens two seconds later in
 * silence reads as a button that does nothing. This writes immediately, cancels the
 * pending timer so the same write does not happen twice, and shows the acknowledgment for
 * a moment.
 */
export async function saveNow(): Promise<void> {
	savePending = true;
	if (saveTimeout) {
		clearTimeout(saveTimeout);
		saveTimeout = null;
	}
	await saveToStorage();
	appState.savedNotice = t('Project saved');
	if (savedNoticeTimer) clearTimeout(savedNoticeTimer);
	savedNoticeTimer = setTimeout(() => {
		appState.savedNotice = null;
		savedNoticeTimer = null;
	}, 2500);
}

let savedNoticeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Save after the debounce, replacing any save already pending.
 *
 * `keep` is for callers whose change is **background work** rather than a user edit: their
 * change still has to reach storage, but it must not push back a save the user's own edit
 * already scheduled. The automatic solver and the comparison's winning colouring both need
 * it — each used to write state and never save it, so what landed on disk was whatever the
 * optimiser had scheduled two seconds earlier, computed for the *previous* positions.
 */
export function scheduleSave(keep = false): void {
	savePending = true;
	if (keep && saveTimeout) return;
	if (saveTimeout) clearTimeout(saveTimeout);
	// `saveToStorage` opens the store itself and reports its own failures; the debounce
	// only has to decide *when*.
	saveTimeout = setTimeout(() => {
		saveTimeout = null;
		/*
		 * On an idle frame, not on the timer's frame.
		 *
		 * The write serialises every floor's masks — megabytes of base64 — and the timer
		 * fires two to five seconds after the last edit, which is exactly when a hand is
		 * still on the mouse. An idle callback puts the same write in the gap between
		 * gestures; the timeout is the guarantee that it still happens if the frame never
		 * goes idle.
		 */
		const run = () => void saveToStorage();
		if (typeof requestIdleCallback === 'function') {
			requestIdleCallback(run, { timeout: 1500 });
		} else {
			run();
		}
	}, SAVE_DELAY);
}

export async function hasSavedState(): Promise<boolean> {
	const store = await ensureStore();
	return (await store.read(STORAGE_KEY)) !== null;
}

/**
 * Write the project synchronously, for the moment the window is going away.
 *
 * Autosave is a five-second debounce and the write behind it is asynchronous, which is
 * the right shape for an edit and the wrong shape for a window that is being destroyed:
 * closing within the debounce window used to lose the last edit, and there is nothing in
 * the app that could have caught it, because a promise chain does not survive the page it
 * belongs to.
 *
 * So this is the one write that can still land: no await, no idle callback. It only
 * touches the document — an underlay has to be decoded and encoded through an `<img>`,
 * which cannot be done synchronously — so it is a safety net, not a replacement for the
 * normal save, and it leaves the pending timer and `savePending` alone for exactly that
 * reason.
 *
 * Returns whether it wrote. `false` means nothing was pending, or the backend in use
 * cannot be written synchronously (IndexedDB cannot: see `KeyValueStore.writeSync`).
 */
export function flushSaveSync(): boolean {
	if (!savePending) return false;
	// `projectStore` is whatever `ensureStore` settled on; before the first open the only
	// store that exists is localstorage's, and using it is right *because* that is the
	// backend in use — not as a guess about which one it might become.
	const store = projectStore ?? (BACKEND === 'localstorage' ? localStore : null);
	if (!store?.writeSync) return false;
	try {
		store.writeSync(
			STORAGE_KEY,
			JSON.stringify(toDocument({ floorCoverage: floorCoverageState }))
		);
		return true;
	} catch {
		// A full quota or a store that has gone away: the async path reports it properly.
		return false;
	}
}

let unloadFlushInstalled = false;

/**
 * Save before the page goes away.
 *
 * Three arrivals, because no single one covers every way this app is closed:
 *
 * - `flush-before-close`, emitted by the desktop shell: it intercepts the window's close,
 *   asks the page, and destroys it either way a moment later (`src-tauri/src/lib.rs`).
 *   This is the only one that is *guaranteed* to run before a close, because a destroyed
 *   webview does not reliably fire `pagehide`.
 * - `pagehide`: the browser's own last call, for `pnpm dev` and any host that is not the
 *   shell.
 * - `visibilitychange` → hidden: the same thing one step earlier, and the only one that
 *   also fires when a phone or a lid suspends the page.
 *
 * Idempotent, and a no-op outside a browser (the layout is prerendered at build time).
 */
export function installUnloadFlush(): void {
	if (unloadFlushInstalled) return;
	if (typeof window === 'undefined' || typeof document === 'undefined') return;
	unloadFlushInstalled = true;

	const flush = (): void => {
		if (!flushSaveSync()) return;
		/*
		 * The synchronous write covered the document. The underlays still need the
		 * asynchronous path, and a page that survives — an alt-tab, a close the user
		 * cancelled — must not be left with a plan that never reached storage.
		 */
		void saveToStorage();
	};

	addEventListener('pagehide', flush);
	addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flush();
	});
	void listenForCloseRequest(flush);
}

/**
 * The shell's "about to close" event, when this build is running inside it.
 *
 * Imported lazily and defensively: the browser build has no `__TAURI_INTERNALS__`, and a
 * shell older than the event has nothing to listen to. Both are cases where `pagehide`
 * remains the fallback, not reasons to fail.
 */
async function listenForCloseRequest(flush: () => void): Promise<void> {
	const host = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
	if (!host) return;
	try {
		const { listen } = await import('@tauri-apps/api/event');
		await listen('flush-before-close', () => flush());
	} catch {
		// No event API: the window still closes, `pagehide` is the fallback.
	}
}
