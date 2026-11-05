import type { CanvasEngine } from '$canvas/engine.js';

/**
 * 当前挂载在视图里的画布引擎。
 *
 * 画布之外的组件（工具栏、状态栏）要指挥它：“现在重绘”“让平面图居中”“导出这一帧”，
 * 但直接 import 画布视图会形成循环依赖。以前这里是模块级 `let` 加 `set`/`get`；
 * 换成 store 后归到状态层，读的人就算在画布出现前就挂载，也能等它到位而不是一直拿着 `null`。
 *
 * 为空是正常的，不是错误：没有平面图视图在屏上时就没有引擎，调用方自己判空。
 */
export const canvasEngineRef = $state({ engine: null as CanvasEngine | null });

export const canvasState = $state({
	zoom: 1,
	selectedApIds: [] as string[],
	hoveredApId: null as string | null,
	isDragging: false,
	/**
	 * 要叠画在平面图上的世界坐标矩形，没有则为 null。
	 *
	 * 由矢量复核面板在用户指向某个元素时设置，让“这一行”在图纸上有具体位置。
	 * 之所以给矩形而不是元素本身，是因为分类器按包围盒工作，而复核的人要看到框才能判断
	 * “那条曲线是门还是楼梯扶手”。
	 *
	 * 每次变化都换新对象，画布那边的 effect 就能按引用比较，不必逐值比对。
	 */
	reviewHighlight: null as { x: number; y: number; w: number; h: number } | null
});

export function selectAp(id: string, addToSelection = false): void {
	if (addToSelection) {
		if (canvasState.selectedApIds.includes(id)) {
			canvasState.selectedApIds = canvasState.selectedApIds.filter((i) => i !== id);
		} else {
			canvasState.selectedApIds = [...canvasState.selectedApIds, id];
		}
	} else {
		canvasState.selectedApIds = [id];
	}
}

export function selectAps(ids: string[]): void {
	canvasState.selectedApIds = ids;
}

export function clearSelection(): void {
	canvasState.selectedApIds = [];
}

export function isSelected(id: string): boolean {
	return canvasState.selectedApIds.includes(id);
}
