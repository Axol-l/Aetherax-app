/**
 * The contract of the current-floor view: `wallState` and `floorplanState` are not copies
 * of the current floor, they *are* it — a write lands on the floor and a read follows the
 * floor that is selected.
 *
 * That is what removed the five hand-written copies of the same nine assignments (save,
 * restore, floor switch, undo, import). A copy can be forgotten; a view cannot be out of
 * date. These assertions are intentionally about the two directions, not about any
 * particular caller.
 */
import { describe, expect, it } from 'vitest';
import { addFloor, floorState, switchFloor } from './floor-state.svelte.js';
import { floorplanState } from './floorplan-state.svelte.js';
import { wallState } from './wall-state.svelte.js';

describe('current-floor view', () => {
	it('writes through to the floor that is selected', () => {
		const floor = floorState.floors[0]!;
		const mask = { dataUrl: 'data:image/png;base64,AA', width: 4, height: 4, originX: 1, originY: 2 };

		wallState.wallMask = mask;
		wallState.wallAttenuation = 9;
		wallState.wallMaterial = 3;
		floorplanState.calibration = { worldUnitsPerMeter: 40 };
		floorplanState.floorplanScale = 0.5;
		floorplanState.floorplanUrl = 'blob:underlay';

		expect(floor.wallMask).toEqual(mask);
		expect(floor.wallAttenuation).toBe(9);
		expect(floor.wallMaterial).toBe(3);
		expect(floor.calibration).toEqual({ worldUnitsPerMeter: 40 });
		expect(floor.floorplanScale).toBe(0.5);
		expect(floor.floorplanUrl).toBe('blob:underlay');
	});

	it('follows a floor switch, in both directions', () => {
		const first = floorState.floors[0]!;
		wallState.wallAttenuation = 4;
		floorplanState.floorplanBoundary = [{ x: 0, y: 0 }];

		const second = addFloor('Upper');
		switchFloor(second.id);

		// A fresh floor reads as itself, not as the floor that was on screen.
		expect(wallState.wallAttenuation).toBe(5);
		expect(floorplanState.floorplanBoundary).toBeNull();

		wallState.wallAttenuation = 11;
		expect(second.wallAttenuation).toBe(11);
		expect(first.wallAttenuation).toBe(4);

		// Coming back shows the first floor's value, not the second's.
		switchFloor(first.id);
		expect(wallState.wallAttenuation).toBe(4);
	});
});
