import type { CanvasEngine } from '../engine.js';
import { floorState } from '$state/floor-state.svelte.js';
import { isInsideInterior } from '$state/ap-interior.js';
import { t } from '$state/i18n.svelte.js';
import { selectAp } from '$state/canvas.svelte.js';
import { appState } from '$state/app.svelte.js';
import { addAp, apState, getEffectiveWupm } from '$state/ap-state.svelte.js';
import { WALL_MOUNT_REACH_M, wallSnapForFloor } from '$state/wall-snap.js';
import { projectMeta } from '$state/project-meta.svelte.js';

export class PlaceHandler {
	private engine: CanvasEngine;

	constructor(engine: CanvasEngine) {
		this.engine = engine;
	}

	async handlePointerDown(e: PointerEvent): Promise<void> {
		if (e.button !== 0) return;

		const rect = this.engine.canvas.getBoundingClientRect();
		const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		const worldPoint = this.engine.camera.screenToWorld(screenPoint);

		/*
		 * 新增 AP 继承的安装方式决定它是否必须落在墙上。一米内有墙时，点击吸附到该墙
		 * 并转向室内，两者取自同一测量（`state/wall-snap.ts`），不会互相矛盾。
		 */
		const mount = appState.apPlaceMount ?? apState.aps.at(-1)?.mount ?? 'ceiling';

		/*
		 * `Allow APs outside rooms` 默认关闭，关闭时墙外空白处的点击会被拒绝。
		 * 壁挂设备不受此限制：它本就装在墙上，下方贴墙检查会拒绝一米内无墙的点击。
		 */
		const floorId = floorState.currentFloorId;
		if (mount !== 'wall' && !projectMeta.allowOutsideRooms) {
			if (floorId && !(await isInsideInterior(floorId, worldPoint.x, worldPoint.y))) {
				appState.placementNotice = t(
					'Outside the building. Turn on "Allow APs outside rooms" to place an access point here.'
				);
				return;
			}
		}

		let x = worldPoint.x;
		let y = worldPoint.y;
		let facingDeg = 0;
		if (mount === 'wall' && floorId) {
			const wupm = getEffectiveWupm();
			const snap = await wallSnapForFloor(floorId, x, y, wupm);
			if (!snap || snap.distanceW > WALL_MOUNT_REACH_M * wupm) {
				appState.placementNotice = t(
					'A wall-mounted access point has to sit on a wall: click within a metre of one, or pick another mounting.'
				);
				return;
			}
			x = snap.apX;
			y = snap.apY;
			facingDeg = snap.facingDeg;
		}

		const ap = addAp(x, y, facingDeg, appState.apPlaceMount);
		appState.placementNotice = null;
		selectAp(ap.id);
		appState.sidebarPanel = 'aps';
		this.engine.markDirty();
	}
}
