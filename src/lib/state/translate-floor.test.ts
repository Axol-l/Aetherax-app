/**
 * Moving a floor moves everything on it.
 *
 * Alignment between two floors is a rigid translation, and it used to move the floorplan
 * offset and the three masks while leaving the *segments* where they were. The mask is derived
 * from the segments now, so the next derivation put the walls back: the drag released and the
 * floor snapped to where it started, and the stacked/3D views — which draw the segments — never
 * moved at all. These tests pin the whole floor down, geometry included.
 */
import { describe, expect, it } from 'vitest';
import { addFloor, getFloor, translateFloor } from './floor-state.svelte.js';

function seedFloor() {
	const floor = addFloor('Test floor');
	floor.walls = [
		{ id: 'w1', ax: 10, ay: 20, bx: 110, by: 20, material: 0 },
		{ id: 'w2', ax: 110, ay: 20, bx: 110, by: 120, material: 3 }
	] as never;
	floor.columns = [{ id: 'c1', shape: 'circle', ax: 50, ay: 50, bx: 70, by: 50, material: 4 }] as never;
	floor.planningArea = [
		{ x: 0, y: 0 },
		{ x: 200, y: 0 },
		{ x: 200, y: 200 }
	];
	floor.surfaces = [{
		id: 's1',
		kind: 'platform',
		ax: 10,
		ay: 10,
		bx: 60,
		by: 60,
		heightM: 2,
		topHeightM: 2
	}] as never;
	floor.notes = [{ id: 'n1', x: 5, y: 6, text: 'here' }] as never;
	return floor;
}

describe('translateFloor', () => {
	it('moves the segments, so the derived mask cannot undo it', () => {
		const floor = seedFloor();
		const before = floor.walls;
		translateFloor(floor.id, 30, -40, []);
		const moved = getFloor(floor.id)!;

		expect(moved.walls?.[0]).toMatchObject({ ax: 40, ay: -20, bx: 140, by: -20 });
		expect(moved.walls?.[1]).toMatchObject({ ax: 140, ay: -20, bx: 140, by: 80 });
		// A new array identity: the derived-mask cache is keyed on it, and an in-place edit
		// would leave the cache holding the mask from before the move.
		expect(moved.walls).not.toBe(before);
	});

	it('moves the columns, the planning area, the raised surfaces and the notes', () => {
		const floor = seedFloor();
		translateFloor(floor.id, 5, 7, []);
		const moved = getFloor(floor.id)!;

		expect(moved.columns?.[0]).toMatchObject({ ax: 55, ay: 57, bx: 75, by: 57 });
		expect(moved.planningArea?.[0]).toMatchObject({ x: 5, y: 7 });
		expect(moved.planningArea?.[2]).toMatchObject({ x: 205, y: 207 });
		expect(moved.surfaces?.[0]).toMatchObject({ ax: 15, ay: 17, bx: 65, by: 67 });
		expect(moved.notes?.[0]).toMatchObject({ x: 10, y: 13 });
	});

	it('moves the APs on this floor only, and the floorplan offset with them', () => {
		const floor = seedFloor();
		const other = addFloor('Other');
		const aps = [
			{ id: 'a1', floorId: floor.id, x: 100, y: 100 },
			{ id: 'a2', floorId: other.id, x: 100, y: 100 }
		];
		translateFloor(floor.id, 10, 10, aps);

		expect(aps[0]).toMatchObject({ x: 110, y: 110 });
		expect(aps[1]).toMatchObject({ x: 100, y: 100 });
		expect(getFloor(floor.id)!.floorplanOffsetX).toBe(10);
		expect(getFloor(floor.id)!.floorplanOffsetY).toBe(10);
	});

	it('moves the masks as new objects, so every derived cache notices', () => {
		const floor = seedFloor();
		floor.wallMask = { dataUrl: 'data:image/png;base64,A', width: 4, height: 4, originX: 1, originY: 2 };
		floor.materialMask = { dataUrl: 'data:image/png;base64,B', width: 4, height: 4, originX: 1, originY: 2 };
		const before = floor.wallMask;

		translateFloor(floor.id, 20, -5, []);
		const moved = getFloor(floor.id)!;

		expect(moved.wallMask).toMatchObject({ originX: 21, originY: -3 });
		expect(moved.materialMask).toMatchObject({ originX: 21, originY: -3 });
		/*
		 * The origin is baked into every field and interior derived from a mask, while the
		 * caches holding those are keyed on the mask's identity — so a mask moved in place is,
		 * to all of them, the mask it was before the floor moved. This is the difference
		 * between "the heatmap followed the floor" and "the heatmap kept its old frame".
		 */
		expect(moved.wallMask).not.toBe(before);
		expect(before).toMatchObject({ originX: 1, originY: 2 });
	});

	it('does nothing for a zero delta', () => {
		const floor = seedFloor();
		const before = floor.walls;
		translateFloor(floor.id, 0, 0, []);
		// The early return keeps the array identity, so nothing downstream invalidates.
		expect(getFloor(floor.id)!.walls).toBe(before);
	});
});
