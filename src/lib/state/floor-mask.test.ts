/**
 * The wall-mask accessor: the one seam every kernel reads a floor's walls through.
 *
 * It used to hand back the stored raster, which made "the segments are the model" true only
 * on the floor on screen — that floor's mask is re-derived by the canvas, while another
 * floor's is whatever was saved with it. The optimiser's all-floor run reads *other* floors,
 * so this is where the claim has to be made true: when a floor has segments, the mask is
 * derived from them here.
 *
 * No canvas is involved on that path — `rasteriseWalls` is arithmetic — so this can be
 * tested without a browser.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { floorState, type Floor } from './floor-state.svelte.js';
import { wallState } from './wall-state.svelte.js';
import { getFloorMask, invalidateSolverMaskCache } from './floor-mask.js';

function floorWithWalls(over: Partial<Floor> = {}): Floor {
	return {
		id: 'f1',
		name: 'Floor 1',
		level: 0,
		ceilingHeight: 3,
		floorThickness: 0.2,
		floorMaterial: 1,
		floorplanUrl: null,
		floorplanScale: 1,
		floorplanOffsetX: 0,
		floorplanOffsetY: 0,
		calibration: { worldUnitsPerMeter: 10 },
		floorplanBoundary: null,
		wallMask: null,
		wallAttenuation: 5,
		wallMaterial: 0,
		materialMask: null,
		roomTypeMask: null,
		roomDensityOverrides: {},
		roomCustomLabels: {},
		planningArea: null,
		surfaces: [],
		walls: [
			{ id: 'w1', ax: 100, ay: 100, bx: 200, by: 100, material: 0 },
			{ id: 'w2', ax: 200, ay: 100, bx: 200, by: 180, material: 0 },
			{ id: 'w3', ax: 200, ay: 180, bx: 100, by: 180, material: 0 },
			{ id: 'w4', ax: 100, ay: 180, bx: 100, by: 100, material: 0 }
		],
		...over
	};
}

/** A pixel of a mask, by world coordinate. */
function at(
	mask: { wallData: Uint8Array; width: number; height: number; originX: number; originY: number },
	x: number,
	y: number
): number {
	const px = Math.round(x) - mask.originX;
	const py = Math.round(y) - mask.originY;
	if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return -1;
	return mask.wallData[py * mask.width + px]!;
}

describe('getFloorMask', () => {
	beforeEach(() => {
		floorState.floors = [floorWithWalls()];
		floorState.currentFloorId = 'f1';
		wallState.wallMask = null;
		wallState.materialMask = null;
		wallState.roomTypeMask = null;
		invalidateSolverMaskCache();
	});

	it('derives the raster from the segments when the floor has no stored mask', async () => {
		const mask = await getFloorMask('f1');
		expect(mask).not.toBeNull();
		// A wall is painted where the segment is, and the room inside it is not.
		expect(at(mask!, 150, 100)).toBe(1);
		expect(at(mask!, 100, 140)).toBe(1);
		expect(at(mask!, 150, 140)).toBe(0);
		// The frame is the segments' own bounding box plus the band's margin, not the
		// whole world: a plan-less floor has nothing else to take a frame from.
		expect(mask!.width).toBeGreaterThan(100);
		expect(mask!.width).toBeLessThan(200);
	});

	it('takes the stored mask as the frame when there is one', async () => {
		floorState.floors = [
			floorWithWalls({
				wallMask: { dataUrl: 'unused', width: 400, height: 300, originX: -50, originY: -20 }
			})
		];
		invalidateSolverMaskCache();
		const mask = await getFloorMask('f1');
		expect(mask!.width).toBe(400);
		expect(mask!.height).toBe(300);
		expect(mask!.originX).toBe(-50);
		expect(at(mask!, 150, 100)).toBe(1);
	});

	it('re-derives when the segments change, and not when nothing did', async () => {
		const first = await getFloorMask('f1');
		const again = await getFloorMask('f1');
		// Same array object: the cache is what keeps a coverage drag from re-rasterising.
		expect(again).toBe(first);

		const floor = floorState.floors[0]!;
		const moved = (floor.walls ?? []).map((wall) =>
			wall.id === 'w1' ? { ...wall, by: 100 + 20 } : wall
		);
		floor.walls = [...moved];
		const second = await getFloorMask('f1');
		expect(second).not.toBe(first);
		expect(at(second!, 150, 140)).toBe(0);
	});

	it('carries the material ids, so the wall material reaches the kernel', async () => {
		const floor = floorState.floors[0]!;
		floor.walls = (floor.walls ?? []).map((wall) => ({ ...wall, material: 3 }));
		const mask = await getFloorMask('f1');
		const px = Math.round(150) - mask!.originX;
		const py = Math.round(100) - mask!.originY;
		expect(mask!.materialMap![py * mask!.width + px]).toBe(3);
	});
});
