import { apState } from './ap-state.svelte.js';
import { wallState } from './wall-state.svelte.js';
import { floorState } from './floor-state.svelte.js';
import { floorplanState } from './floorplan-state.svelte.js';
import type { AccessPoint } from './ap-state.svelte.js';
import type { Floor } from './floor-state.svelte.js';
import type { WallMaterialId } from '$canvas/materials.js';

const MAX_HISTORY = 50;

interface Snapshot {
	aps: AccessPoint[];
	wallMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX: number;
		originY: number;
	} | null;
	materialMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX: number;
		originY: number;
	} | null;
	roomTypeMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX: number;
		originY: number;
	} | null;
	wallMaterial: WallMaterialId;
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
	// Sync current floor's legacy atom state before snapshotting
	// (floor data is normally only synced on floor switch)
	const cur = floorState.floors.find((f) => f.id === floorState.currentFloorId);
	if (cur) {
		cur.floorplanUrl = floorplanState.floorplanUrl;
		cur.floorplanScale = floorplanState.floorplanScale;
		cur.calibration = floorplanState.calibration;
		cur.floorplanBoundary = floorplanState.floorplanBoundary;
		cur.wallMask = wallState.wallMask;
		cur.wallAttenuation = wallState.wallAttenuation;
		cur.wallMaterial = wallState.wallMaterial;
		cur.materialMask = wallState.materialMask;
		cur.roomTypeMask = wallState.roomTypeMask;
	}

	return {
		aps: cloneValue(apState.aps),
		wallMask: wallState.wallMask ? { ...wallState.wallMask } : null,
		materialMask: wallState.materialMask ? { ...wallState.materialMask } : null,
		roomTypeMask: wallState.roomTypeMask ? { ...wallState.roomTypeMask } : null,
		wallMaterial: wallState.wallMaterial,
		floors: cloneValue(floorState.floors),
		currentFloorId: floorState.currentFloorId
	};
}

function applySnapshot(snap: Snapshot): void {
	apState.aps = snap.aps;
	floorState.floors = snap.floors;
	floorState.currentFloorId = snap.currentFloorId;
	// Sync current floor's wall data to legacy atoms
	const cur = snap.floors.find((f) => f.id === snap.currentFloorId) ?? snap.floors[0];
	if (cur) {
		wallState.wallMask = cur.wallMask;
		wallState.materialMask = cur.materialMask;
		wallState.roomTypeMask = cur.roomTypeMask;
		wallState.wallMaterial = cur.wallMaterial;
		wallState.wallAttenuation = cur.wallAttenuation;
		floorplanState.floorplanUrl = cur.floorplanUrl;
		floorplanState.floorplanScale = cur.floorplanScale;
		floorplanState.calibration = cur.calibration;
		floorplanState.floorplanBoundary = cur.floorplanBoundary;
	} else {
		wallState.wallMask = snap.wallMask;
		wallState.materialMask = snap.materialMask;
		wallState.roomTypeMask = snap.roomTypeMask;
		wallState.wallMaterial = snap.wallMaterial;
	}
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
	console.info(`[history] snapshot in ${Math.round(performance.now() - started)} ms`);
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
