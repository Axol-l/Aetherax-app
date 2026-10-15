/**
 * The composition of role buffers into the two masks.
 *
 * Small, and load-bearing: the wall mask is the optimiser's placement domain and the
 * coverage denominator, and the material mask is what tells the RF model that a door
 * is not a wall. Both come out of this one function, so the two rules that matter are
 * pinned here — openings stay *in* the mask, and they *win* the material.
 */
import { describe, expect, it } from 'vitest';
import { composeRoleMasks, DOOR_MATERIAL, WINDOW_MATERIAL } from './vector-detect.js';
import { DEFAULT_MATERIAL } from './materials.js';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('composeRoleMasks', () => {
	it('puts every role into the wall mask, because an opening is still a barrier', () => {
		// Punching doors out of the mask would open every room whose only entrance is
		// one, and `computeBuildingInterior` would stop finding the interior.
		const { wall } = composeRoleMasks(
			[
				{ material: null, pixels: bytes(1, 0, 0) },
				{ material: WINDOW_MATERIAL, pixels: bytes(0, 1, 0) },
				{ material: DOOR_MATERIAL, pixels: bytes(0, 0, 1) }
			],
			DEFAULT_MATERIAL
		);
		expect(Array.from(wall)).toEqual([1, 1, 1]);
	});

	it('paints each opening its own material and leaves plain walls on the default', () => {
		const { material } = composeRoleMasks(
			[
				{ material: null, pixels: bytes(1, 0, 0) },
				{ material: WINDOW_MATERIAL, pixels: bytes(0, 1, 0) },
				{ material: DOOR_MATERIAL, pixels: bytes(0, 0, 1) }
			],
			DEFAULT_MATERIAL
		);
		expect(Array.from(material)).toEqual([DEFAULT_MATERIAL, WINDOW_MATERIAL, DOOR_MATERIAL]);
	});

	it('leaves a pixel on the default material when nothing claims it', () => {
		const { wall, material } = composeRoleMasks([{ material: null, pixels: bytes(0, 0) }], 4);
		expect(Array.from(wall)).toEqual([0, 0]);
		expect(Array.from(material)).toEqual([4, 4]);
	});

	it('lets the opening win where a door is drawn over the wall it sits in', () => {
		// The normal case: a door leaf and its swing arc are stroked across the wall
		// run, so both buffers are set on the same pixels.
		const { wall, material } = composeRoleMasks(
			[
				{ material: DOOR_MATERIAL, pixels: bytes(1, 1) },
				{ material: null, pixels: bytes(1, 1) }
			],
			DEFAULT_MATERIAL
		);
		expect(Array.from(wall)).toEqual([1, 1]);
		expect(Array.from(material)).toEqual([DOOR_MATERIAL, DOOR_MATERIAL]);
	});

	it('does not care which order the caller passes the roles in', () => {
		const wallFirst = composeRoleMasks(
			[
				{ material: null, pixels: bytes(1) },
				{ material: WINDOW_MATERIAL, pixels: bytes(1) }
			],
			DEFAULT_MATERIAL
		);
		const windowFirst = composeRoleMasks(
			[
				{ material: WINDOW_MATERIAL, pixels: bytes(1) },
				{ material: null, pixels: bytes(1) }
			],
			DEFAULT_MATERIAL
		);
		expect(Array.from(wallFirst.material)).toEqual(Array.from(windowFirst.material));
	});

	it('returns empty masks when there is nothing to compose', () => {
		const { wall, material } = composeRoleMasks([], DEFAULT_MATERIAL);
		expect(wall.length).toBe(0);
		expect(material.length).toBe(0);
	});
});
