/**
 * 画布键盘映射。
 * 视图独有的四项能力通过 `hooks` 传入，其余都是快捷键与点击同样有权修改的状态。
 * 分支顺序属于行为的一部分：依次为撤销/重做、模式退出与模式专属键、删除选中对象、全局键。
 */
import { removeAps } from '$state/ap-state.svelte.js';
import {
	appState,
	setApPlaceMode,
	setCalibrateMode,
	setFloorAlignMode,
	setPlanningDrawMode,
	setSurfaceMode
} from '$state/app.svelte.js';
import { canvasState, clearSelection } from '$state/canvas.svelte.js';
import { canvasEngineRef } from '$state/canvas.svelte.js';
import { floorState } from '$state/floor-state.svelte.js';
import { pushState, redo, undo } from '$state/history.svelte.js';
import { updateCoverage } from '$state/optimizer.svelte.js';
import { saveNow, scheduleSave } from '$state/persistence.svelte.js';

/** 视图拥有的四个手势，因为它们会触及视图的图层。 */
export interface ShortcutHooks {
	/** 离开墙体工具并清除其草稿选择。 */
	stopWallMode(): void;
	/** 若规划区域草稿已有三个角点，则闭合它。 */
	commitPlanningDraft(): void;
	/** 放弃进行中的楼层对齐拖拽。 */
	cancelAlignDrag(): void;
	/** 根据楼层的墙体段重新推导掩码。 */
	syncVectorWallsToMask(forceEmpty?: boolean): void;
}

/** 为画布处理一次按键。 */
export function handleShortcut(e: KeyboardEvent, hooks: ShortcutHooks): void {
	const target = e.target as HTMLElement;
	const isInput =
		target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
	const mod = e.metaKey || e.ctrlKey;
	const markDirty = () => canvasEngineRef.engine?.markDirty();

	/*
	 * 撤销与重做优先，任何模式下都是。
	 *
	 * 撤销属于项目而非当前打开的工具，因此在其他逻辑取用按键之前处理。
	 */
	if (mod && (e.key === 'z' || e.key === 'Z')) {
		e.preventDefault();
		if (e.shiftKey) redo();
		else undo();
		// 撤销改变了项目，必须像其他编辑一样写入存储；否则存储仍保留被撤销的状态，下次重载会恢复它。
		scheduleSave();
		markDirty();
		return;
	}

	if (!isInput && appState.wallVectorMode && e.key === 'Escape') {
		hooks.stopWallMode();
		return;
	}

	if (
		!isInput &&
		(appState.wallVectorSelected || appState.wallColumnSelected) &&
		(e.key === 'Delete' || e.key === 'Backspace')
	) {
		// 选中的墙段或柱是选中对象：删除接入点所用的同一按键也删除它，且必须先于下方的 AP 分支消费按键。
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		const wallSelected =
			!!appState.wallVectorSelected &&
			!!floor?.walls?.some((wall) => wall.id === appState.wallVectorSelected);
		const columnSelected =
			!!appState.wallColumnSelected &&
			!!floor?.columns?.some((column) => column.id === appState.wallColumnSelected);
		if (wallSelected || columnSelected) {
			e.preventDefault();
			pushState();
			if (wallSelected) {
				floor!.walls = (floor!.walls ?? []).filter(
					(wall) => wall.id !== appState.wallVectorSelected
				);
				appState.wallVectorSelected = null;
			} else {
				floor!.columns = (floor!.columns ?? []).filter(
					(column) => column.id !== appState.wallColumnSelected
				);
				appState.wallColumnSelected = null;
			}
			// 楼层上最后一道障碍：掩码必须随之在其现有帧内清空，否则模型会继续把不存在的墙计入。
			const segmentsLeft = (floor!.walls ?? []).length + (floor!.columns ?? []).length === 0;
			if (segmentsLeft) hooks.syncVectorWallsToMask(true);
			scheduleSave();
			markDirty();
			return;
		}
	}

	if (!isInput && appState.planningDrawMode && e.key === 'Enter') {
		hooks.commitPlanningDraft();
		return;
	}

	if (!isInput && appState.planningDrawMode && (e.key === 'Backspace' || e.key === 'Delete')) {
		// 先于下方的 AP 删除：此模式下 Backspace 表示“上一个角点画错了”，是用户最常用的纠正方式。
		e.preventDefault();
		if (appState.planningDraft.length > 0) {
			appState.planningDraft = appState.planningDraft.slice(0, -1);
			// 撤销一个角点会重新打开已在第一个角点闭合的回路。
			appState.planningDraftClosed = false;
		}
		return;
	}

	if (!isInput && e.key === 'Escape' && appState.planningDrawMode) {
		// 放弃回路：未完成的轮廓不代表对楼层的任何声明。
		setPlanningDrawMode(false);
		return;
	}

	if (!isInput && e.key === 'Escape' && appState.surfaceMode) {
		// 半画完的矩形不是表面；离开模式即丢弃它。
		setSurfaceMode(false);
		return;
	}

	if (!isInput && appState.surfaceSelected && (e.key === 'Delete' || e.key === 'Backspace')) {
		// 选中的表面是选中对象，与墙体和 AP 一样。
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (floor?.surfaces?.some((surface) => surface.id === appState.surfaceSelected)) {
			e.preventDefault();
			pushState();
			floor.surfaces = (floor.surfaces ?? []).filter(
				(surface) => surface.id !== appState.surfaceSelected
			);
			appState.surfaceSelected = null;
			void updateCoverage();
			markDirty();
			scheduleSave();
			return;
		}
	}

	if (!isInput && e.key === 'Escape' && appState.calibrateMode) {
		// 测量线属于该模式，离开模式即丢弃；侧边栏保留输入的距离，但没有可应用它的线。
		setCalibrateMode(false);
		return;
	}

	if (!isInput && e.key === 'Escape' && appState.floorAlignMode) {
		// Escape 是退出模式的常规方式；只依赖侧边栏开关会让模式看起来卡住。
		hooks.cancelAlignDrag();
		setFloorAlignMode(false);
		return;
	}

	if (!isInput && e.key === 'Escape' && appState.apPlaceMode) {
		// 同理：占用画布的模式必须能直接用 Escape 退出，而无需去操作侧边栏。
		setApPlaceMode(false);
		return;
	}

	if (mod && (e.key === 's' || e.key === 'S')) {
		// Ctrl+S is the app's own save: write the storage slot and answer visibly.
		// Handing the user a file is a different action — File → Export Project File.
		e.preventDefault();
		void saveNow();
		return;
	}

	if (e.key === 'Delete' || e.key === 'Backspace') {
		if (canvasState.selectedApIds.length > 0) {
			e.preventDefault();
			removeAps([...canvasState.selectedApIds]);
			clearSelection();
		}
	}

	if (isInput || mod) return;

	switch (e.key) {
		case 'g':
		case 'G':
			appState.showGrid = !appState.showGrid;
			break;
		case 'w':
		case 'W':
			appState.showWalls = !appState.showWalls;
			break;
		case 'h':
		case 'H':
			appState.showHeatmap = !appState.showHeatmap;
			break;
	}
}
