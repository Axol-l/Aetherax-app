import { debug } from '$lib/log.js';
import { floorCoverage as floorCoverageState } from './optimizer.svelte.js';
import { floorState } from './floor-state.svelte.js';
import { clearHistory } from './history.svelte.js';
import { appState } from './app.svelte.js';
import { t } from './i18n.svelte.js';
import { applyDocument, migrate, toDocument } from './project-document.js';
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
		debug(`[save] written in ${Math.round(performance.now() - started)} ms`);
		persistenceState.lastSaved = new Date();
		// A later save that works clears the warning: storage was full, and is not any
		// more.
		appState.storageNotice = null;
	} catch {
		appState.storageNotice = t(
			'The project could not be saved: the browser storage is full or unavailable. Export it to a file (File → Export JSON), then remove a floorplan or a floor to make room.'
		);
	}

	// Persist floorplan images per floor, separately from the document: a PNG mask per
	// floor is megabytes, and keeping it out of the project record is what lets the
	// record itself stay small enough to write quickly.
	try {
		for (const floor of floorState.floors) {
			if (floor.floorplanUrl && floor.floorplanUrl.startsWith('blob:')) {
				const key = `${FLOORPLAN_KEY}:${floor.id}`;
				const canvas = document.createElement('canvas');
				const img = new Image();
				img.onload = () => {
					canvas.width = img.naturalWidth;
					canvas.height = img.naturalHeight;
					const ctx = canvas.getContext('2d')!;
					ctx.drawImage(img, 0, 0);
					void store.write(key, canvas.toDataURL('image/png')).catch(() => {
						// too large: the project document is what has to land
					});
				};
				img.src = floor.floorplanUrl;
			}
		}
	} catch {
		// Ignore
	}
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
		await migrateInto(store, [STORAGE_KEY, FLOORPLAN_KEY]);
	} catch {
		// The legacy copy is still there and still readable: carry on with what we have
		// rather than starting the app with no project at all.
	}
	projectStore = store;
	return store;
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

		const doc = migrate(JSON.parse(raw));
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
			const perFloor = await store.read(`${FLOORPLAN_KEY}:${floor.id}`);
			if (perFloor) floor.floorplanImage = perFloor;
		}
		if (!doc.floors[0]!.floorplanImage) {
			const legacyFloorplan = await store.read(FLOORPLAN_KEY);
			if (legacyFloorplan) doc.floors[0]!.floorplanImage = legacyFloorplan;
		}

		applyDocument(doc, { floorCoverage: floorCoverageState });
		clearHistory();
		return true;
	} catch {
		return false;
	}
}

export async function clearSavedState(): Promise<void> {
	const store = await ensureStore();
	await store.remove(STORAGE_KEY);
	await store.remove(FLOORPLAN_KEY);
	// Clear per-floor floorplan keys
	for (const floor of floorState.floors) {
		await store.remove(`${FLOORPLAN_KEY}:${floor.id}`);
	}
	persistenceState.lastSaved = null;
}

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
