import { debug } from '$lib/log.js';
import { apState } from './ap-state.svelte.js';
import { floorState } from './floor-state.svelte.js';
import type { AccessPoint } from './ap-state.svelte.js';
import type { Floor } from './floor-state.svelte.js';

const MAX_HISTORY = 50;

/**
 * 还原一个项目所需的快照内容
 */
interface Snapshot {
	aps: AccessPoint[];
	floors: Floor[];
	currentFloorId: string;
}

let undoStack: Snapshot[] = $state([]);
let redoStack: Snapshot[] = $state([]);

/**
 * 把项目里的普通数据做一次结构拷贝
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
	// 计时：快照要复制楼层和 AP 列表，而且每个手势开头都会拍一次（拖动、画、删除）
	// debug(`[history] snapshot in ${Math.round(performance.now() - started)} ms`);
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
