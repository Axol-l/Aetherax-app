/**
 * 画布手势状态机：指针、触摸、环绕视角与楼层对齐拖拽；每个手势都是同构的小状态机，释放时判定点击还是拖拽。
 * `GestureHost` 是视图提供的动作接缝；阈值、长按计时器、捏合基准、环绕角度与对齐增量都集中在这里。
 */
import type { CanvasEngine } from './engine.js';
import type { DragHandler } from './interactions/drag.js';
import type { PlaceHandler } from './interactions/place.js';
import type { SelectHandler } from './interactions/select.js';
import type { FloorTilesLayer } from './renderers/floor-tiles.js';
import type { ReferenceFloorLayer } from './renderers/reference-floor.js';
import type { StackedFloorsLayer } from './renderers/stacked-floors.js';
import { hitTest } from './hit-test.js';
import { noteAtPoint } from './renderers/notes.js';
import { surfaceEdgeNear } from './renderers/surfaces.js';
import {
	columnAtPoint,
	snapToWalls,
	wallNearPoint,
	type VectorColumn,
	type VectorWall
} from '$state/vector-walls.js';
import {
	STACK_MAX_PITCH_DEG,
	STACK_MIN_PITCH_DEG,
	STACK_YAW_LIMIT_DEG,
	addCalibrationPoint,
	addPlanningPoint,
	appState,
	closePlanningDraft
} from '$state/app.svelte.js';
import { apState } from '$state/ap-state.svelte.js';
import { floorState, switchFloor } from '$state/floor-state.svelte.js';
import { pushState } from '$state/history.svelte.js';

interface Point {
	x: number;
	y: number;
}

/** 手势可以回落的动作集合，由视图提供。 */
export interface GestureHost {
	engine(): CanvasEngine | undefined;
	select(): SelectHandler;
	drag(): DragHandler;
	place(): PlaceHandler;
	stacked(): StackedFloorsLayer | undefined;
	tiles(): FloorTilesLayer | undefined;
	reference(): ReferenceFloorLayer | undefined;
	/** 墙面/房间栅格上的点击，单位为画布像素；已处理时返回 true。 */
	wallClick(screenX: number, screenY: number): boolean;
	/** 右键或长按触发的上下文动作，单位为画布像素；弹窗打开时返回 true。 */
	contextAction(screenX: number, screenY: number): boolean;
	/** 闭合正在绘制的规划回路，并使其成为当前楼层的区域。 */
	commitPlanningDraft(): void;
	commitSurface(world: Point): void;
	vectorWallClick(world: Point, shiftKey: boolean): void;
	addNote(world: Point): void;
	eraseWall(world: Point): boolean;
	currentWalls(): VectorWall[];
	currentNotes(): ReadonlyArray<{ id: string; x: number; y: number; text: string }>;
	snapTolerance(): number;
	noteTolerance(): number;
	/** 应用一次结束的楼层对齐拖拽，单位为世界坐标。 */
	commitAlign(dxWorld: number, dyWorld: number): void;
}

/** 指针移动仍算点击而不算拖拽的最大距离，单位为像素。 */
const DRAG_THRESHOLD = 5;
/** 触摸上下文动作的长按延迟，单位为毫秒。 */
const LONG_PRESS_MS = 500;
/** 堆叠/3D 总览中每指针像素对应的视图旋转角度，单位为度。 */
const ORBIT_DEG_PER_PX = 0.4;

export class CanvasGestures {
	/** 绘制墙体时的指针位置，用于橡皮筋预览。 */
	vectorCursor = $state<Point | null>(null);
	/** 点击会吸附到的端点，指针靠近时以描边环标出。 */
	vectorSnap = $state<Point | null>(null);
	/** 绘制规划区域时的指针位置，用于驱动橡皮筋预览。 */
	planningCursor = $state<Point | null>(null);

	private pendingPlace = false;
	private pendingPan = false;
	private pointerStartX = 0;
	private pointerStartY = 0;
	private activeTouches = 0;

	// 单指状态
	private touchStartX = 0;
	private touchStartY = 0;
	private touchMoved = false;
	private touchStartedOnAp = false;

	// 双指捏合状态
	private pinchLastDist = 0;
	private pinchLastCx = 0;
	private pinchLastCy = 0;
	private pinchFrames = 0;

	// 长按状态
	private longPressTimer: ReturnType<typeof setTimeout> | null = null;
	private longPressFired = false;

	// 堆叠总览的视角拖拽
	private orbitPointerId: number | null = null;
	private orbitStartX = 0;
	private orbitStartY = 0;
	private orbitLastX = 0;
	private orbitLastY = 0;
	private orbitYaw = 0;
	private orbitPitch = 0;
	private orbitMoved = false;

	// 楼层对齐拖拽。屏幕坐标增量被保留，因为相机在屏幕空间工作而 translateFloor 使用世界坐标；
	// 缩放即换算系数，且可能在拖拽途中因滚轮而改变。
	private alignDragging = false;
	private alignStartClientX = 0;
	private alignStartClientY = 0;
	private alignStartX = 0;
	private alignStartY = 0;
	private alignDxScreen = 0;
	private alignDyScreen = 0;

	/** 当前橡皮擦笔画是否已压入撤销状态。 */
	private eraserStrokePushed = false;

	constructor(private readonly host: GestureHost) {}

	/** 放弃楼层对齐拖拽，不移动楼层。 */
	cancelAlignDrag(): void {
		const engine = this.host.engine();
		if (!this.alignDragging) return;
		this.alignDragging = false;
		if (engine) {
			engine.camera.pan(
				this.alignStartX - engine.camera.state.x,
				this.alignStartY - engine.camera.state.y
			);
			engine.markDirty();
		}
		const reference = this.host.reference();
		if (reference) {
			reference.compensateX = 0;
			reference.compensateY = 0;
		}
	}

	/**
	 * 指针离开画布。
	 *
	 * 清除堆叠高亮和墙体光标，因为本应触发清除的指针移动不会到达。
	 */
	handlePointerLeave(): void {
		const stacked = this.host.stacked();
		if (stacked?.hoverFloorId) {
			stacked.hoverFloorId = null;
			this.host.engine()?.markDirty();
		}
		if (this.vectorCursor) {
			this.vectorCursor = null;
			this.vectorSnap = null;
			// 离开画布的笔画已结束；下一笔是独立的撤销步骤。
			this.eraserStrokePushed = false;
			this.host.engine()?.markDirty();
		}
	}

	handleTouchStart(e: TouchEvent): void {
		this.activeTouches = e.touches.length;

		if (this.activeTouches === 1) {
			const t = e.touches[0]!;
			this.touchStartX = t.clientX;
			this.touchStartY = t.clientY;
			this.touchMoved = false;
			this.touchStartedOnAp = false;
			this.pendingPan = false;
			this.longPressFired = false;

			// 启动长按计时器，用于墙面/房间的上下文动作
			if (this.longPressTimer) clearTimeout(this.longPressTimer);
			const lpX = t.clientX;
			const lpY = t.clientY;
			this.longPressTimer = setTimeout(() => {
				this.longPressTimer = null;
				if (this.touchMoved || this.activeTouches !== 1) return;
				const engine = this.host.engine();
				if (!engine) return;
				const rect = engine.canvas.getBoundingClientRect();
				if (this.host.contextAction(lpX - rect.left, lpY - rect.top)) {
					this.longPressFired = true;
				}
			}, LONG_PRESS_MS);
		} else if (this.activeTouches >= 2) {
			e.preventDefault();
			// 取消长按与单指状态
			if (this.longPressTimer) {
				clearTimeout(this.longPressTimer);
				this.longPressTimer = null;
			}
			this.pendingPan = false;
			this.touchStartedOnAp = false;
			this.touchMoved = true;
			this.host.drag().handlePointerUp();
			// 初始化捏合
			this.pinchFrames = 0;
			this.pinchLastDist = 0;
		}
	}

	handleTouchMove(e: TouchEvent): void {
		const engine = this.host.engine();
		if (!engine) return;

		// 双指：捏合缩放 + 平移
		if (e.touches.length === 2) {
			e.preventDefault();
			const t0 = e.touches[0]!;
			const t1 = e.touches[1]!;
			const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
			const cx = (t0.clientX + t1.clientX) / 2;
			const cy = (t0.clientY + t1.clientY) / 2;

			this.pinchFrames++;
			if (this.pinchFrames <= 2) {
				// 基准帧：只记录，不应用
				this.pinchLastDist = dist;
				this.pinchLastCx = cx;
				this.pinchLastCy = cy;
				return;
			}

			// 缩放
			if (this.pinchLastDist > 0) {
				const factor = dist / this.pinchLastDist;
				const rect = engine.canvas.getBoundingClientRect();
				engine.camera.zoomAt({ x: cx - rect.left, y: cy - rect.top }, factor);
			}

			// 平移
			engine.camera.pan(
				(cx - this.pinchLastCx) / engine.camera.state.zoom,
				(cy - this.pinchLastCy) / engine.camera.state.zoom
			);

			this.pinchLastDist = dist;
			this.pinchLastCx = cx;
			this.pinchLastCy = cy;
			engine.markDirty();
			return;
		}

		// 单指
		if (e.touches.length !== 1) return;
		const t = e.touches[0]!;

		const dx = t.clientX - this.touchStartX;
		const dy = t.clientY - this.touchStartY;

		if (
			!this.touchMoved &&
			!this.touchStartedOnAp &&
			!this.pendingPan &&
			dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD
		) {
			this.touchMoved = true;
			if (this.longPressTimer) {
				clearTimeout(this.longPressTimer);
				this.longPressTimer = null;
			}
			const rect = engine.canvas.getBoundingClientRect();
			const hit = hitTest(
				{ x: this.touchStartX - rect.left, y: this.touchStartY - rect.top },
				engine.camera,
				apState.aps.filter((ap) => ap.floorId === floorState.currentFloorId)
			);

			if (hit) {
				this.touchStartedOnAp = true;
				const synth = new PointerEvent('pointerdown', {
					clientX: this.touchStartX,
					clientY: this.touchStartY,
					button: 0
				});
				this.host.select().handlePointerDown(synth);
				this.host.drag().handlePointerDown(synth);
			} else {
				this.pendingPan = true;
				this.pointerStartX = this.touchStartX;
				this.pointerStartY = this.touchStartY;
			}
		}

		if (this.touchStartedOnAp && this.host.drag().isDragging) {
			this.host
				.drag()
				.handlePointerMove(
					new PointerEvent('pointermove', { clientX: t.clientX, clientY: t.clientY })
				);
		} else if (this.pendingPan) {
			engine.camera.pan(
				(t.clientX - this.pointerStartX) / engine.camera.state.zoom,
				(t.clientY - this.pointerStartY) / engine.camera.state.zoom
			);
			this.pointerStartX = t.clientX;
			this.pointerStartY = t.clientY;
			engine.markDirty();
		}
	}

	handleTouchEnd(e: TouchEvent): void {
		const engine = this.host.engine();
		if (this.longPressTimer) {
			clearTimeout(this.longPressTimer);
			this.longPressTimer = null;
		}

		if (this.activeTouches === 1 && e.touches.length === 0) {
			// 长按已弹出上下文菜单时跳过点按动作
			if (!this.touchMoved && !this.longPressFired && engine) {
				const rect = engine.canvas.getBoundingClientRect();
				const sx = this.touchStartX - rect.left;
				const sy = this.touchStartY - rect.top;
				const hit = hitTest(
					{ x: sx, y: sy },
					engine.camera,
					apState.aps.filter((ap) => ap.floorId === floorState.currentFloorId)
				);

				if (hit) {
					this.host.select().handlePointerDown(
						new PointerEvent('pointerdown', {
							clientX: this.touchStartX,
							clientY: this.touchStartY,
							button: 0
						})
					);
				} else if (appState.apPlaceMode) {
					// 触摸跟随鼠标：放置模式下点按即放置一个 AP，点按墙面也一样。
					this.host.place().handlePointerDown(
						new PointerEvent('pointerdown', {
							clientX: this.touchStartX,
							clientY: this.touchStartY,
							button: 0
						})
					);
				}
			}
			this.pendingPan = false;
			this.touchStartedOnAp = false;
			this.host.drag().handlePointerUp();
			this.host.select().handlePointerUp(new PointerEvent('pointerup'));
		}
		this.activeTouches = e.touches.length;
		if (this.activeTouches === 0) {
			this.pinchFrames = 0;
			this.pinchLastDist = 0;
		}
	}

	handlePointerDown(e: PointerEvent): void {
		const engine = this.host.engine();
		if (!engine) return;
		if (e.button !== 0) return; // 仅处理主（左）键
		if (e.pointerType === 'touch') return;
		// 在总览视图中，点击用于选择楼层；那里不编辑几何，而拖拽会旋转视图而不是选择。
		if (appState.floorView !== 'single') {
			this.orbitPointerId = e.pointerId;
			this.orbitStartX = e.clientX;
			this.orbitStartY = e.clientY;
			this.orbitLastX = e.clientX;
			this.orbitLastY = e.clientY;
			this.orbitYaw = appState.stackYaw;
			this.orbitPitch = appState.stackPitch;
			this.orbitMoved = false;
			return;
		}
		// 绘制矢量墙：第一次点击开始一段，第二次点击提交该段。
		if (appState.wallVectorMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			this.host.vectorWallClick(world, e.shiftKey);
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// 注释图钉目标很小且位于最上层：无论注释模式是否开启，它都先于选择逻辑接收点击，
		// 因为点击图钉查看内容是最直接的操作。
		{
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			if (appState.noteMode) {
				this.host.addNote(world);
				engine.markDirty();
				e.preventDefault();
				return;
			}
			const hit = appState.showNotes
				? noteAtPoint(this.host.currentNotes(), world, this.host.noteTolerance())
				: null;
			if (hit) {
				appState.noteSelectedId = hit.id;
				engine.markDirty();
				e.preventDefault();
				return;
			}
			// 点击平面本身会清除注释选中，与其他选中行为一致。
			if (appState.noteSelectedId) appState.noteSelectedId = null;
		}
		// 绘制规划区域会拦截主键点击：每次点击都是正在勾勒的回路的一个角点，
		// 该手势开启时没有其他逻辑使用它。
		if (appState.planningDrawMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			// 图形已闭合并等待工具条确认：此后的点击不得绕过确认继续添加角点。
			if (appState.planningDraftClosed) {
				e.preventDefault();
				return;
			}
			// 角点会吸附到已绘制的墙体，吸附后的点立即落位：瞄准与提交之间没有第二次点击或确认按钮。
			const point = this.planningPoint(world);
			const draft = appState.planningDraft;
			/*
			 * 点击第一个角点会闭合回路：只闭合图形，不代表确认。
			 *
			 * 工具条与绿色确认按钮仍然保留，因此区域在被替换前仍可撤销或取消。
			 */
			const closes =
				draft.length >= 3 &&
				Math.hypot(point.x - draft[0]!.x, point.y - draft[0]!.y) <= this.host.snapTolerance();
			if (closes) {
				closePlanningDraft();
				this.planningCursor = null;
			} else addPlanningPoint(point);
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// 绘制抬升表面：两次点击确定一对对角。第一次指定起点，第二次提交，
		// 与墙体绘制的手感保持一致。
		if (appState.surfaceMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			this.host.commitSurface(world);
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// 测量校准会拦截主键点击，先于放置和选中：该模式开启时，
		// 点击只是测量线的一个点，不触发其他操作。
		if (appState.calibrateMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			addCalibrationPoint({ x: world.x, y: world.y });
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// 对齐模式拦截主指针。PanZoomHandler 仅在中键平移，因此这里的左键拖拽不会与之冲突。
		if (appState.floorAlignMode) {
			this.alignDragging = true;
			this.alignDxScreen = 0;
			this.alignDyScreen = 0;
			this.alignStartClientX = e.clientX;
			this.alignStartClientY = e.clientY;
			this.alignStartX = engine.camera.state.x;
			this.alignStartY = engine.camera.state.y;
			pushState();
			e.preventDefault();
			return;
		}
		this.processPointerDown(e);
	}

	private processPointerDown(e: PointerEvent): void {
		const engine = this.host.engine();
		if (!engine) return;
		if (this.activeTouches >= 2) return;

		const rect = engine.canvas.getBoundingClientRect();
		const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		const hit = hitTest(
			screenPoint,
			engine.camera,
			apState.aps.filter((ap) => ap.floorId === floorState.currentFloorId)
		);

		if (hit) {
			this.host.select().handlePointerDown(e);
			this.host.drag().handlePointerDown(e);
			this.pendingPlace = false;
			this.pendingPan = false;
		} else if (e.shiftKey) {
			this.host.select().handlePointerDown(e);
			this.pendingPlace = false;
			this.pendingPan = false;
		} else if (appState.apPlaceMode) {
			/*
			 * 放置模式接管空白画布上的点击，包括墙体附近区域。
			 *
			 * 墙体安装点必须点在靠近墙的位置，因此该手势不能先被墙体或柱的选择拦截。
			 */
			this.pointerStartX = e.clientX;
			this.pointerStartY = e.clientY;
			this.pendingPlace = true;
			this.pendingPan = false;
		} else {
			// 已绘制的墙体是对象：在其附近点击会选中它，而不是开始框选；Delete 删除，右键更改材质。
			const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
			// 先判断表面边缘：轮廓是夹层中唯一明确的部分，其内部画布仍留给放置接入点。
			if (floor?.surfaces?.length) {
				const world = engine.camera.screenToWorld(screenPoint);
				const surface = surfaceEdgeNear(
					floor.surfaces,
					world.x,
					world.y,
					10 / (engine.camera.state.zoom || 1)
				);
				if (surface) {
					appState.surfaceSelected = surface.id;
					appState.wallVectorSelected = null;
					this.pendingPlace = false;
					this.pendingPan = false;
					engine.markDirty();
					return;
				}
			}
			const walls = (floor?.walls ?? []) as VectorWall[];
			if (walls.length > 0) {
				const world = engine.camera.screenToWorld(screenPoint);
				const wall = wallNearPoint(world, walls, 12 / (engine.camera.state.zoom || 1));
				if (wall) {
					appState.wallVectorSelected = wall.id;
					appState.wallColumnSelected = null;
					this.pendingPlace = false;
					this.pendingPan = false;
					engine.markDirty();
					return;
				}
			}
			if ((floor?.columns ?? []).length > 0) {
				const world = engine.camera.screenToWorld(screenPoint);
				const column = columnAtPoint((floor?.columns ?? []) as VectorColumn[], world);
				if (column) {
					appState.wallColumnSelected = column.id;
					appState.wallVectorSelected = null;
					this.pendingPlace = false;
					this.pendingPan = false;
					engine.markDirty();
					return;
				}
			}
			if (appState.wallVectorSelected || appState.wallColumnSelected) {
				appState.wallVectorSelected = null;
				appState.wallColumnSelected = null;
				engine.markDirty();
			}
			if (appState.surfaceSelected) {
				appState.surfaceSelected = null;
				engine.markDirty();
			}
			// 空白画布上的点击仅在放置模式添加 AP；否则它是选择手势（点击清除，拖拽框选），
			// 与 Shift+点击相同。
			this.pointerStartX = e.clientX;
			this.pointerStartY = e.clientY;
			this.pendingPan = false;
			if (appState.apPlaceMode) {
				this.pendingPlace = true;
			} else {
				this.pendingPlace = false;
				this.host.select().handlePointerDown(e);
			}
		}
	}

	/**
	 * 规划点击所代表的点。
	 *
	 * 角点会吸附到已绘制的墙体（先端点后边，与墙体工具规则相同），吸附后的点直接落位，没有确认步骤。
	 */
	private planningPoint(world: Point): Point {
		const walls = this.host.currentWalls();
		if (walls.length === 0) return world;
		return snapToWalls(world, walls, this.host.snapTolerance()).point;
	}

	handlePointerMove(e: PointerEvent): void {
		const engine = this.host.engine();
		if (!engine) return;
		// 悬停注释图钉会显示其文本，所有模式下都是如此：查看注释从来不是当前模式的主手势。
		if (appState.showNotes && appState.floorView === 'single') {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			const hovered = noteAtPoint(this.host.currentNotes(), world, this.host.noteTolerance());
			if ((hovered?.id ?? null) !== appState.noteHoverId) {
				appState.noteHoverId = hovered?.id ?? null;
				engine.markDirty();
			}
		}
		if (appState.wallVectorMode) {
			const rect = engine.canvas.getBoundingClientRect();
			this.vectorCursor = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			/*
			 * 橡皮擦按笔画工作而非按点击：笔刷经过的墙体都会被删除，一次撤销恢复整笔。
			 *
			 * `buttons` 指示指针是否按下；没有按下时的移动只是悬停，不得删除任何东西。
			 */
			if (appState.wallTool === 'eraser') {
				if ((e.buttons & 1) !== 0) {
					if (!this.eraserStrokePushed) {
						pushState();
						this.eraserStrokePushed = true;
					}
					if (this.host.eraseWall(this.vectorCursor)) engine.markDirty();
				}
				this.vectorSnap = null;
				engine.markDirty();
				return;
			}
			if (appState.wallTool === 'line') {
				// 点击将落到的位置，使圆环能提示将与哪面墙相接。
				const snapped = snapToWalls(
					this.vectorCursor,
					this.host.currentWalls(),
					this.host.snapTolerance()
				);
				this.vectorSnap =
					snapped.point.x !== this.vectorCursor.x || snapped.point.y !== this.vectorCursor.y
						? snapped.point
						: null;
			} else {
				this.vectorSnap = null;
				// 墩柱或柱从第一次点击起跟随指针，与墙体一致。
				if (appState.columnDraft) {
					appState.columnDraft = {
						...appState.columnDraft,
						bx: this.vectorCursor.x,
						by: this.vectorCursor.y
					};
				}
			}
			engine.markDirty();
			return;
		}
		if (appState.noteMode) return;
		// 绘制抬升表面：第二个角点跟随指针，便于在提交点击前判断矩形。
		if (appState.surfaceMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			if (appState.surfaceDraft) {
				appState.surfaceDraft = { ...appState.surfaceDraft, bx: world.x, by: world.y };
				engine.markDirty();
			}
			return;
		}
		// 绘制规划区域时指针驱动橡皮筋：预览下一条边与闭合边，便于在闭合前判断形状。
		if (appState.planningDrawMode) {
			// 闭合回路没有橡皮筋：在撤销之前没有下一个角点。
			if (appState.planningDraftClosed) {
				if (this.planningCursor !== null) {
					this.planningCursor = null;
					engine.markDirty();
				}
				return;
			}
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			// 橡皮筋终止于点击将吸附到的墙体，因此角点会预览在它实际落位上。
			this.planningCursor = this.planningPoint(world);
			engine.markDirty();
			return;
		}
		if (e.pointerType === 'touch') return;
		// 旋转总览视角，并确定堆叠视图中指针下方的楼层板。只读且开销很小；
		// 只有发生变化时才标记画布脏，移动指针不会逐像素重绘。
		if (appState.floorView === 'stacked' || appState.floorView === 'floor3d') {
			// 视图拖拽期间没有可报告的悬停：指针正握住相机，而不是指向某个楼层。
			if (this.orbitPointerId === e.pointerId) {
				const dx = e.clientX - this.orbitStartX;
				const dy = e.clientY - this.orbitStartY;
				if (!this.orbitMoved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
					this.orbitMoved = true;
					const stacked = this.host.stacked();
					if (stacked) stacked.hoverFloorId = null;
					// 从这里开始累积，而不是从拖拽起点：否则阈值距离本身会在第一步被当作转动，
					// 看起来像小跳变。
					this.orbitLastX = e.clientX;
					this.orbitLastY = e.clientY;
				}
				if (this.orbitMoved) {
					this.orbitYaw = clamp(
						this.orbitYaw - (e.clientX - this.orbitLastX) * ORBIT_DEG_PER_PX,
						-STACK_YAW_LIMIT_DEG,
						STACK_YAW_LIMIT_DEG
					);
					this.orbitPitch = clamp(
						this.orbitPitch - (e.clientY - this.orbitLastY) * ORBIT_DEG_PER_PX,
						STACK_MIN_PITCH_DEG,
						STACK_MAX_PITCH_DEG
					);
					this.orbitLastX = e.clientX;
					this.orbitLastY = e.clientY;
					appState.stackYaw = this.orbitYaw;
					appState.stackPitch = this.orbitPitch;
					return;
				}
			}
			const stacked = this.host.stacked();
			if (appState.floorView === 'stacked' && stacked) {
				const rect = engine.canvas.getBoundingClientRect();
				const world = engine.camera.screenToWorld({
					x: e.clientX - rect.left,
					y: e.clientY - rect.top
				});
				const hovered = stacked.floorAt(world.x, world.y);
				if (hovered !== stacked.hoverFloorId) {
					stacked.hoverFloorId = hovered;
					engine.markDirty();
				}
			}
		}
		if (this.alignDragging) {
			// 相机承载当前楼层，参考层以相同量反向偏移，保持锚定在所属楼层；
			// 释放时相机复位，由楼层自身坐标接管位移，避免跳变。
			this.alignDxScreen = e.clientX - this.alignStartClientX;
			this.alignDyScreen = e.clientY - this.alignStartClientY;
			const cam = engine.camera;
			cam.pan(
				this.alignStartX + this.alignDxScreen - cam.state.x,
				this.alignStartY + this.alignDyScreen - cam.state.y
			);
			const reference = this.host.reference();
			if (reference) {
				const zoom = cam.state.zoom || 1;
				reference.compensateX = -this.alignDxScreen / zoom;
				reference.compensateY = -this.alignDyScreen / zoom;
			}
			engine.markDirty();
			return;
		}
		if (this.host.drag().isDragging) {
			this.host.drag().handlePointerMove(e);
			return;
		}

		if (this.pendingPlace) {
			const dx = e.clientX - this.pointerStartX;
			const dy = e.clientY - this.pointerStartY;
			if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
				// 超出阈值：这是平移，而不是点按放置
				this.pendingPlace = false;
				this.pendingPan = true;
				// 从原始位置开始平移
				engine.canvas.style.cursor = 'grabbing';
			}
		}

		if (this.pendingPan) {
			const dx = (e.clientX - this.pointerStartX) / engine.camera.state.zoom;
			const dy = (e.clientY - this.pointerStartY) / engine.camera.state.zoom;
			engine.camera.pan(dx, dy);
			this.pointerStartX = e.clientX;
			this.pointerStartY = e.clientY;
			engine.markDirty();
			return;
		}

		this.host.select().handlePointerMove(e);
	}

	handlePointerUp(e: PointerEvent): void {
		const engine = this.host.engine();
		if (!engine) return;
		if (e.button !== 0) return; // 仅处理主（左）键
		// 橡皮擦笔画随指针抬起而结束：下一笔是独立的撤销步骤。
		this.eraserStrokePushed = false;
		// 总览视图的拖拽与点击判定，在释放时完成。
		if (this.orbitPointerId === e.pointerId) {
			this.orbitPointerId = null;
			if (!this.orbitMoved && appState.floorView !== 'single') {
				const r = engine.canvas.getBoundingClientRect();
				const world = engine.camera.screenToWorld({
					x: e.clientX - r.left,
					y: e.clientY - r.top
				});
				const picked =
					appState.floorView === 'stacked'
						? this.host.stacked()?.floorAt(world.x, world.y)
						: this.host.tiles()?.tileAt(world.x, world.y);
				if (picked) switchFloor(picked);
			}
			return;
		}
		if (this.alignDragging) {
			this.alignDragging = false;
			const zoom = engine.camera.state.zoom || 1;
			const dxWorld = this.alignDxScreen / zoom;
			const dyWorld = this.alignDyScreen / zoom;
			// 移动楼层前先复位相机：楼层即将以自身坐标承载位移，而相机此前已承载同一位移，
			// 两者叠加会造成双倍移动。
			engine.camera.pan(
				this.alignStartX - engine.camera.state.x,
				this.alignStartY - engine.camera.state.y
			);
			const reference = this.host.reference();
			if (reference) {
				reference.compensateX = 0;
				reference.compensateY = 0;
			}
			if (dxWorld !== 0 || dyWorld !== 0) this.host.commitAlign(dxWorld, dyWorld);
			engine.markDirty();
			return;
		}
		if (this.pendingPlace) {
			this.pendingPlace = false;
			// 放置模式接管点击：指针下的墙是挂墙件的落点，而不是材质弹窗；
			// PlaceHandler 内部会拒绝离墙过远的挂墙点。
			this.host.place().handlePointerDown(e);
		}

		if (this.pendingPan) {
			this.pendingPan = false;
			engine.canvas.style.cursor = '';
		}

		this.host.select().handlePointerUp(e);
		this.host.drag().handlePointerUp();
	}
}

/** 把值限制到区间内，用于环绕拖拽的每步限幅。 */
function clamp(value: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, value));
}
