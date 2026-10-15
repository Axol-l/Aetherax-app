/**
 * Which walls a wall-mounted access point may attach to.
 *
 * A virtual partition is a modelling line: it attenuates nothing, and it is drawn across
 * an open plan to separate areas. There is no surface on it, so a wall mount must not
 * attach — its facing would come from a line that radiates both ways.
 */
import { describe, expect, it } from 'vitest';
import { attachableWallMask } from './wall-snap.js';

/**
 * Ids from `WALL_MATERIALS`: virtual partition is the one whose table attenuates nothing
 * in any band, which is what `isVirtualMaterial` tests for.
 */
const DRYWALL = 0;
const BRICK = 3;
const VIRTUAL_PARTITION = 6;

/** A 1x4 strip: drywall, a virtual partition, brick, and a floor pixel. */
function strip() {
	const wallData = new Uint8Array([1, 1, 1, 0, 1]);
	const materialMap = new Uint8Array([DRYWALL, VIRTUAL_PARTITION, BRICK, 0, DRYWALL]);
	return { wallData, materialMap };
}

describe('attachableWallMask', () => {
	it('keeps walls and drops virtual partitions', () => {
		const { wallData, materialMap } = strip();
		const attachable = attachableWallMask(wallData, materialMap, DRYWALL);
		expect([...attachable]).toEqual([1, 0, 1, 0, 1]);
	});

	it('reads the floor default for pixels the material mask does not cover', () => {
		const { wallData } = strip();
		// No material mask at all: every wall is whatever the floor's default is, which is
		// how a plan looks before anyone paints materials.
		expect([...attachableWallMask(wallData, null, DRYWALL)]).toEqual([...wallData]);
		// ...and when that default *is* virtual, no wall is attachable.
		expect([...attachableWallMask(wallData, null, VIRTUAL_PARTITION)]).toEqual([...wallData]);
	});

	it('treats an uncovered wall pixel as the default material', () => {
		// A material mask that is smaller than the wall mask, or zero where nobody painted:
		// zero is Drywall, so a wall stays attachable.
		const wallData = new Uint8Array([1, 1]);
		const materialMap = new Uint8Array([0, VIRTUAL_PARTITION]);
		expect([...attachableWallMask(wallData, materialMap, DRYWALL)]).toEqual([1, 0]);
	});
});
