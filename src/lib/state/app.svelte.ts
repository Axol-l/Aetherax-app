/**
 * 全局界面状态：当前工具、图层开关、画布视图和角落提示。
 */
import type { SurfaceKind, SurfaceMaterialId } from '$lib/rf/surface-height.js';
import type { ApMount } from './ap-state.svelte.js';

export type SidebarPanel = 'floorplan' | 'aps';
export type FloorView = 'single' | 'tiled' | 'stacked' | 'floor3d';

/**
 * 当前启用的编辑工具，没启用时是 none
 */
export type ToolKind =
	| 'none'
	| 'wall'
	| 'note'
	| 'align'
	| 'calibrate'
	| 'planning'
	| 'surface'
	| 'place-ap';

/**
 * 叠层视图的角度限制，单位是度
 */
export const STACK_YAW_LIMIT_DEG = 180;
export const STACK_MIN_PITCH_DEG = 5;
export const STACK_MAX_PITCH_DEG = 75;

export const appState = $state({
	placementNotice: null as string | null,
	storageNotice: null as string | null,
	savedNotice: null as string | null,
	/**
	 * 有 AP 落在建筑外面时的常驻警告
	 */
	outsideNotice: null as string | null,
	/** 有 AP 落在柱子内部时的常驻警告。 */
	columnNotice: null as string | null,
	/**
	 * 优化设置改过、但还没重跑时的一次性提示。
	 *
	 * 只在「结果变旧」的那一刻弹一次；关掉之后不再骚扰，屏幕上的布局仍然是旧的。
	 */
	staleSettingsNotice: null as string | null,
	sidebarPanel: 'floorplan' as SidebarPanel,
	sidebarOpen: true,
	showGrid: true,
	showLabels: true,
	showHeatmap: false,
	/** 热力图指标：RSSI、SINR 或估算 PHY 速率。 */
	heatmapMetric: 'rssi' as 'rssi' | 'sinr' | 'rate',
	heatmapProbe: null as {
		mcs: number;
		widthMhz: number;
		streams: number;
		phyMbps: number;
		throughputMbps: number;
	} | null,
	showNotes: true,
	/**
	 * 当前启用的编辑工具。
	 */
	tool: 'none' as ToolKind,

	/**
	 * 用线段画墙。
	 */
	get wallVectorMode(): boolean {
		return this.tool === 'wall';
	},
	set wallVectorMode(on: boolean) {
		if (on) setTool('wall');
		else if (this.tool === 'wall') setTool('none');
	},
	/**
	 * 墙工具画什么形状：线段、矩形墙垛，还是圆柱。
	 */
	wallTool: 'line' as 'line' | 'rect' | 'circle' | 'eraser',
	/** 正在画的墙垛或圆柱，用两个对角点表示。 */
	columnDraft: null as { shape: 'rect' | 'circle'; ax: number; ay: number; bx: number; by: number } | null,
	/** 指针下或刚画好的柱子，给删除键用。 */
	wallColumnSelected: null as string | null,
	wallVectorDraft: null as { x: number; y: number } | null,
	/** 指针下或刚画好的那段墙，给删除键用。 */
	wallVectorSelected: null as string | null,
	/**
	 * 墙体刚发生了什么，在角落显示几秒。
	 */
	wallNotice: null as string | null,
	/**
	 * 备注编辑：在图上点一下就放一个备注。
	 */
	get noteMode(): boolean {
		return this.tool === 'note';
	},
	set noteMode(on: boolean) {
		if (on) setTool('note');
		else if (this.tool === 'note') setTool('none');
	},
	/** 指针下的备注，给悬停气泡用。 */
	noteHoverId: null as string | null,
	/** 正在编辑的备注，没有就是 null。 */
	noteSelectedId: null as string | null,
	showFloorplan: true,
	showAPs: true,
	showWalls: true,
	showRoomLabels: true,
	/** 下一层的半透明底图，用来对齐上下两层。 */
	showFloorBelow: false,
	/**
	 * 在画布上拖动时整个当前楼层跟着走，而不是平移或框选。
	 * 用来把一层对准另一层。
	 */
	get floorAlignMode(): boolean {
		return this.tool === 'align';
	},
	set floorAlignMode(on: boolean) {
		if (on) setTool('align');
		else if (this.tool === 'align') setTool('none');
	},
	/** 在图上点两个点，用一条已知长度的线来标定比例。 */
	get calibrateMode(): boolean {
		return this.tool === 'calibrate';
	},
	set calibrateMode(on: boolean) {
		if (on) setTool('calibrate');
		else if (this.tool === 'calibrate') setTool('none');
	},
	/**
	 * 画规划区域：点一下加一个顶点，回车闭合。
	 */
	get planningDrawMode(): boolean {
		return this.tool === 'planning';
	},
	set planningDrawMode(on: boolean) {
		if (on) setTool('planning');
		else if (this.tool === 'planning') setTool('none');
	},
	planningDraft: [] as Array<{ x: number; y: number }>,
	/**
	 * 草稿已经点回第一个角闭合了，但还没确认。
	 */
	planningDraftClosed: false,
	/**
	 * 画抬升面：夹层、楼梯、坡道。
	 */
	get surfaceMode(): boolean {
		return this.tool === 'surface';
	},
	set surfaceMode(on: boolean) {
		if (on) setTool('surface');
		else if (this.tool === 'surface') setTool('none');
	},
	surfaceDraft: null as { ax: number; ay: number; bx: number; by: number } | null,
	surfaceKind: 'platform' as SurfaceKind,
	/**
	 * 下一个抬升面用的台面材质，null 表示「自己填损耗」。
	 */
	surfaceMaterial: null as SurfaceMaterialId | null,
	/** 低端行走面的高度，单位米，相对本层地面。 */
	surfaceHeightM: 2,
	/** 高端的高度，单位米。平台会让它跟 `surfaceHeightM` 相等。 */
	surfaceTopHeightM: 2,
	/** 穿过台面的损耗，dB：从下面上来穿过它的路径要付多少。 */
	surfaceAttenuationDb: 15,
	/** 台面本身的厚度，米。影响 3D 显示，也决定路径算不算穿过它。 */
	surfaceThicknessM: 0.2,
	/** 3D 里台面下方到地面之间的体积是否填实。 */
	surfaceSolidBase: false,
	/** 指针下或刚画好的抬升面：卡片编辑它，Delete 删它。 */
	surfaceSelected: null as string | null,
	/** 标定过程中收集到的点击，世界坐标。 */
	calibrationPoints: [] as Array<{ x: number; y: number }>,
	/**
	 * 点画布空白处就新增一个接入点
	 */
	get apPlaceMode(): boolean {
		return this.tool === 'place-ap';
	},
	set apPlaceMode(on: boolean) {
		if (on) setTool('place-ap');
		else if (this.tool === 'place-ap') setTool('none');
	},
	/**
	 * 下一个放置的 AP 用哪种安装方式
	 */
	apPlaceMount: null as ApMount | null,
	floorView: 'single' as FloorView,
	/**
	 * 叠层总览从哪个角度看。
	 *
	 * `stackYaw` 绕竖轴转，`stackPitch` 往下俯，两者合起来就是全部视角。
	 */
	stackYaw: 0,
	stackPitch: 40,
	stackSpread: 1,
	/** 只画当前层和它上下各一层。 */
	stackFocus: false
});

/** 为真表示底图是对齐模式打开的，退出时好还原。 */
let alignOwnsGhost = false;

/**
 * 启用一个工具，或者全都不启用
 */
export function setTool(tool: ToolKind): void {
	const current = appState.tool;
	if (current === tool) return;

	if (current === 'align' && alignOwnsGhost) {
		appState.showFloorBelow = false;
		alignOwnsGhost = false;
	}
	if (current === 'calibrate') appState.calibrationPoints = [];
	if (current === 'planning') {
		appState.planningDraft = [];
		appState.planningDraftClosed = false;
	}
	if (current === 'surface') appState.surfaceDraft = null;

	appState.tool = tool;

	if (tool === 'align') {
		alignOwnsGhost = !appState.showFloorBelow;
		appState.showFloorBelow = true;
	}
	if (tool === 'calibrate') appState.calibrationPoints = [];
}

/**
 * 进入或退出楼层对齐模式
 */
export function setFloorAlignMode(on: boolean): void {
	if (on) setTool('align');
	else if (appState.tool === 'align') setTool('none');
}

/**
 * 打开或关闭放置 AP。
 */
export function setApPlaceMode(on: boolean): void {
	if (on) setTool('place-ap');
	else if (appState.tool === 'place-ap') setTool('none');
}

/**
 * 用图上量一条线的方式来标定
 */
export function setCalibrateMode(on: boolean): void {
	if (on) setTool('calibrate');
	else if (appState.tool === 'calibrate') setTool('none');
}

/**
 * 标定时记一次点击：先第一点，再第二点
 */
export function addCalibrationPoint(point: { x: number; y: number }): void {
	if (appState.calibrationPoints.length >= 2) appState.calibrationPoints = [point];
	else appState.calibrationPoints = [...appState.calibrationPoints, point];
}

/**
 * 画规划区域，一下一个顶点
 */
export function setPlanningDrawMode(on: boolean): void {
	if (on) setTool('planning');
	else if (appState.tool === 'planning') setTool('none');
}

export function addPlanningPoint(point: { x: number; y: number }): void {
	appState.planningDraft = [...appState.planningDraft, point];
}

/**
 * 把正在画的圈闭合
 */
export function closePlanningDraft(): void {
	if (appState.planningDraft.length >= 3) appState.planningDraftClosed = true;
}

/**
 * 画抬升面
 */
export function setSurfaceMode(on: boolean): void {
	if (on) setTool('surface');
	else if (appState.tool === 'surface') setTool('none');
}

/**
 * 说一句墙体刚发生的事
 */
let wallsNoticeTimer: ReturnType<typeof setTimeout> | null = null;
export function notifyWalls(message: string): void {
	appState.wallNotice = message;
	if (wallsNoticeTimer) clearTimeout(wallsNoticeTimer);
	wallsNoticeTimer = setTimeout(() => {
		wallsNoticeTimer = null;
		appState.wallNotice = null;
	}, 7000);
}
