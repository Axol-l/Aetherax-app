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
		 * `Allow APs outside rooms` is off by default and it means what it says, not just
		 * "the optimiser keeps them inside": a click in the margin outside the walls used to
		 * drop an access point there with nothing said about it.
		 */
		const floorId = floorState.currentFloorId;
		if (!projectMeta.allowOutsideRooms) {
			if (floorId && !(await isInsideInterior(floorId, worldPoint.x, worldPoint.y))) {
				appState.placementNotice = t(
					'Outside the building. Turn on "Allow APs outside rooms" to place an access point here.'
				);
				return;
			}
		}

		/*
		 * The mounting the new access point inherits decides whether it has to land on a
		 * wall: a wall-mounted unit radiates away from the wall it is screwed to, so one
		 * in the middle of a room is not that. Within a metre of a wall the click is
		 * snapped onto that wall and the unit is turned to face into the room — both from
		 * the same measurement (`state/wall-snap.ts`), so they cannot disagree.
		 */
		const mount = appState.apPlaceMount ?? apState.aps.at(-1)?.mount ?? 'ceiling';
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
