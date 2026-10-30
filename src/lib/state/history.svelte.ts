import { debug } from '$lib/log.js';
import { apState } from './ap-state.svelte.js';
import { floorState } from './floor-state.svelte.js';
import type { AccessPoint } from './ap-state.svelte.js';
import type { Floor } from './floor-state.svelte.js';

const MAX_HISTORY = 50;

/**
 * What a snapshot has to hold to restore a project.
 *
 * Only the floors and the AP list: the wall and underlay data is *on* the floor now (see
 * `wall-state.ts`), so snapshotting it separately — which this used to do, and which needed
 * a manual copy in both directions — was a second copy of the same bytes.
 */
interface Snapshot {
	aps: AccessPoint[];
	floors: Floor[];
	currentFloorId: string;
}

let undoStack: Snapshot[] = $state([]);
let redoStack: Snapshot[] = $state([]);

/**
 * A structural copy of the project's plain data.
 *
 * The obvious `JSON.parse(JSON.stringify(floors))` copies every **wall mask's data URL** —
 * megabytes of base64 per floor — on every snapshot, and a snapshot is taken on every AP
 * placement, every deletion and every drag. That parse is what made placing an access point
 * stall. A data URL is a string and strings are immutable, so the copy can share it: only the
 * objects and arrays around it are copied, which is kilobytes.
 */
function cloneValue<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T;
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = cloneValue(item);
		}
		return out as T;
	}
	// Strings, numbers, booleans, null: shared, and the masks are the strings that matter.
	return value;
}

function takeSnapshot(): Snapshot {
	return {
		aps: cloneValue(apState.aps),
		floors: cloneValue(floorState.floors),
		currentFloorId: floorState.currentFloorId
	};
}

function applySnapshot(snap: Snapshot): void {
	apState.aps = snap.aps;
	floorState.floors = snap.floors;
	floorState.currentFloorId = snap.currentFloorId;
}

export function pushState(): void {
	const started = performance.now();
	undoStack.push(takeSnapshot());
	if (undoStack.length > MAX_HISTORY) {
		undoStack.shift();
	}
	redoStack.length = 0;
	// Timed: a snapshot copies the floors and the AP list, and it is taken at the start of
	// every gesture (drag, draw, delete) — a place a stall is felt as "it hangs".
	debug(`[history] snapshot in ${Math.round(performance.now() - started)} ms`);
}

export function undo(): void {
	if (undoStack.length === 0) return;
	redoStack.push(takeSnapshot());
	applySnapshot(undoStack.pop()!);
}

export function redo(): void {
	if (redoStack.length === 0) return;
	undoStack.push(takeSnapshot());
	applySnapshot(redoStack.pop()!);
}

export function canUndo(): boolean {
	return undoStack.length > 0;
}

export function canRedo(): boolean {
	return redoStack.length > 0;
}

export function clearHistory(): void {
	undoStack.length = 0;
	redoStack.length = 0;
}
