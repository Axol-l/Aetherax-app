/**
 * 找出中心落在柱子内部的 AP。
 *
 * 柱子是实体障碍；AP 放在里面时，直射路径从障碍内部开始，覆盖率和热力图都会
 * 变得没有意义，所以界面要给一个常驻警告。
 */
import { apState } from './ap-state.svelte.js';
import { floorState } from './floor-state.svelte.js';

interface ColumnLike {
	shape: 'rect' | 'circle';
	ax: number;
	ay: number;
	bx: number;
	by: number;
}

export function pointInsideColumn(column: ColumnLike, x: number, y: number): boolean {
	if (column.shape === 'circle') {
		const radius = Math.hypot(column.bx - column.ax, column.by - column.ay);
		return Math.hypot(x - column.ax, y - column.ay) <= radius;
	}
	const minX = Math.min(column.ax, column.bx);
	const maxX = Math.max(column.ax, column.bx);
	const minY = Math.min(column.ay, column.by);
	const maxY = Math.max(column.ay, column.by);
	return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

/** 所有落在柱子内部的 AP，返回“AP 名（楼层名）”。 */
export function apsInsideColumns(): string[] {
	const names: string[] = [];
	for (const floor of floorState.floors) {
		const columns = floor.columns ?? [];
		if (columns.length === 0) continue;
		for (const ap of apState.aps) {
			if (ap.floorId !== floor.id) continue;
			if (columns.some((column) => pointInsideColumn(column, ap.x, ap.y))) {
				names.push(`${ap.name} (${floor.name})`);
			}
		}
	}
	return names;
}
