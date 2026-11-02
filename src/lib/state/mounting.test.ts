/**
 * Mounting geometry: where an access point is, and what that changes.
 *
 * The functions under test are the only places the vertical term is decided, and
 * every consumer of it — the heatmap, the live coverage figure, the optimiser's
 * payload and the worker — reads them rather than deriving its own. An AP's height
 * is always modelled, so these are not two models to switch between: the ceiling
 * preset is simply the one a new AP starts from.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	CEILING_MOUNT_DROP_M,
	MOUNT_PRESETS,
	addAp,
	antennaProfileFor,
	apHeightAboveFloor,
	apSplitFor,
	apState,
	apVerticalOffsetTo,
	defaultMountHeight
} from './ap-state.svelte.js';
import { azimuthLossDb, WALL_MOUNT_AZIMUTH } from '$lib/rf/antenna.js';
import { floorState } from './floor-state.svelte.js';
import { projectMeta } from './project-meta.svelte.js';

/** Two storeys, 3 m and 2.5 m, and nothing else in the store. */
function seedFloors(): void {
	floorState.floors = [
		{
			id: 'f1',
			name: 'Floor 1',
			level: 0,
			ceilingHeight: 3,
			floorMaterial: 1,
			floorThickness: 0.2,
			floorplanUrl: null,
			floorplanScale: 1,
			floorplanOffsetX: 0,
			floorplanOffsetY: 0,
			calibration: null,
			floorplanBoundary: null,
			wallMask: null,
			wallAttenuation: 5,
			wallMaterial: 0,
			materialMask: null,
			roomTypeMask: null,
			roomDensityOverrides: {},
			roomCustomLabels: {}
		},
		{
			id: 'f2',
			name: 'Floor 2',
			level: 1,
			ceilingHeight: 2.5,
			floorMaterial: 1,
			floorThickness: 0.2,
			floorplanUrl: null,
			floorplanScale: 1,
			floorplanOffsetX: 0,
			floorplanOffsetY: 0,
			calibration: null,
			floorplanBoundary: null,
			wallMask: null,
			wallAttenuation: 5,
			wallMaterial: 0,
			materialMask: null,
			roomTypeMask: null,
			roomDensityOverrides: {},
			roomCustomLabels: {}
		}
	];
	floorState.currentFloorId = 'f1';
}

afterEach(() => {
	apState.aps = [];
	projectMeta.clientHeight = 1.5;
});

describe('defaultMountHeight', () => {
	it('hangs a ceiling mount just below the slab', () => {
		expect(defaultMountHeight('ceiling', 3)).toBeCloseTo(3 - CEILING_MOUNT_DROP_M, 6);
		expect(defaultMountHeight('ceiling', 2.5)).toBeCloseTo(2.4, 6);
	});

	it('uses a fixed height for a floor mount, independent of the storey', () => {
		expect(defaultMountHeight('floor', 3)).toBeCloseTo(0.8, 6);
		expect(defaultMountHeight('floor', 2.5)).toBeCloseTo(0.8, 6);
	});

	it('never puts an access point through the slab above it, or under the floor', () => {
		// A storey shorter than the ceiling drop leaves the AP on the floor rather
		// than below it, and one shorter than a desk leaves it there too.
		expect(defaultMountHeight('floor', 1)).toBeCloseTo(0.8, 6);
		expect(defaultMountHeight('ceiling', 0.05)).toBe(0);
	});
});

describe('apHeightAboveFloor', () => {
	it('is the AP’s own height, clamped to its storey', () => {
		seedFloors();
		expect(apHeightAboveFloor({ floorId: 'f1', mountHeightM: 0.8 })).toBeCloseTo(0.8, 6);
		expect(apHeightAboveFloor({ floorId: 'f1', mountHeightM: 4.2 })).toBeCloseTo(3, 6);
		expect(apHeightAboveFloor({ floorId: 'f1', mountHeightM: -1 })).toBeCloseTo(0, 6);
		expect(apHeightAboveFloor({ floorId: 'f2', mountHeightM: 2.2 })).toBeCloseTo(2.2, 6);
	});
});

describe('apVerticalOffsetTo', () => {
	it('is the height difference to a client on the same floor', () => {
		seedFloors();
		// 0.8 m to a 1.5 m client is 0.7 m: a same-floor path is not flat.
		expect(apVerticalOffsetTo({ floorId: 'f1', mountHeightM: 0.8 }, 'f1', 1.5)).toBeCloseTo(
			0.7,
			6
		);
		// Sign does not matter: only the distance does.
		expect(apVerticalOffsetTo({ floorId: 'f1', mountHeightM: 2.9 }, 'f1', 1.5)).toBeCloseTo(
			1.4,
			6
		);
		// A floor-mounted AP below a client is the same 0.7 m from the other side.
		expect(apVerticalOffsetTo({ floorId: 'f1', mountHeightM: 2.2 }, 'f1', 1.5)).toBeCloseTo(
			0.7,
			6
		);
	});

	it('is the whole geometric gap to a client on another floor', () => {
		seedFloors();
		// A floor-mounted AP 0.8 m up on floor 1, a client 1.5 m above floor 2 (3 m up):
		// 3 + 1.5 - 0.8 = 3.7 m.
		expect(apVerticalOffsetTo({ floorId: 'f1', mountHeightM: 0.8 }, 'f2', 1.5)).toBeCloseTo(
			3.7,
			6
		);
		// A ceiling-mounted one on floor 1: 3 + 1.5 - 2.9 = 1.6 m, which is the mount
		// the model assumed before heights existed.
		expect(apVerticalOffsetTo({ floorId: 'f1', mountHeightM: 2.9 }, 'f2', 1.5)).toBeCloseTo(
			1.6,
			6
		);
		// From floor 2 down to a client on floor 1: AP at 3 + 1.6 = 4.6, client at 1.5.
		expect(apVerticalOffsetTo({ floorId: 'f2', mountHeightM: 1.6 }, 'f1', 1.5)).toBeCloseTo(
			3.1,
			6
		);
	});
});

describe('apSplitFor', () => {
	it('never splits a same-floor path', () => {
		seedFloors();
		expect(apSplitFor({ floorId: 'f1', mountHeightM: 0.8 }, 'f1', 1.5)).toEqual({
			sourceT: 0,
			targetT: 0
		});
	});

	it('splits a path that never leaves the client floor’s volume nowhere', () => {
		seedFloors();
		// A ceiling-mounted AP on floor 1 is at 3 m and the client on floor 2 at 4.5 m:
		// the only plane between them is floor 2's at 3 m, which is the endpoint itself.
		expect(apSplitFor({ floorId: 'f1', mountHeightM: 3 }, 'f2', 1.5)).toEqual({
			sourceT: 0,
			targetT: 0
		});
	});

	it('splits a floor-mounted path at the plane it crosses', () => {
		seedFloors();
		// From 0.8 m up to 4.5 m the ray crosses floor 2's plane at 3 m, i.e. 2.2/3.7
		// of the way along.
		const floorMounted = apSplitFor({ floorId: 'f1', mountHeightM: 0.8 }, 'f2', 1.5);
		expect(floorMounted.sourceT).toBeCloseTo(2.2 / 3.7, 6);
		expect(floorMounted.targetT).toBeCloseTo(2.2 / 3.7, 6);
	});
});

describe('addAp', () => {
	it('starts a new access point on the ceiling of its storey', () => {
		seedFloors();
		const ap = addAp(10, 10);
		expect(ap.mount).toBe('ceiling');
		expect(ap.mountHeightM).toBeCloseTo(2.9, 6);
		expect(ap.floorId).toBe('f1');
	});

	it('carries the previous AP’s mounting over to the next one', () => {
		seedFloors();
		const first = addAp(10, 10);
		first.mount = 'floor';
		first.mountHeightM = 0.8;
		const second = addAp(20, 20);
		expect(second.mount).toBe('floor');
		expect(second.mountHeightM).toBeCloseTo(0.8, 6);
	});

	it('takes the mounting the placement toolbar picked, and its preset height', () => {
		seedFloors();
		// The last AP is a wall mount, so inheriting would make the next one a wall mount
		// too; the toolbar's choice has to win.
		const first = addAp(10, 10);
		first.mount = 'wall';
		first.mountHeightM = 1.5;

		const ceiling = addAp(20, 20, 0, 'ceiling');
		expect(ceiling.mount).toBe('ceiling');
		expect(ceiling.mountHeightM).toBeCloseTo(2.9, 6);

		const wall = addAp(30, 30, 90, 'wall');
		expect(wall.mount).toBe('wall');
		expect(wall.mountHeightM).toBeCloseTo(2, 6);
		// The caller's measured facing still wins for a wall mount.
		expect(wall.facingDeg).toBe(90);
	});

	it('starts an access point with its band’s antenna, and carries that over too', () => {
		seedFloors();
		const ap = addAp(10, 10);
		expect(ap.beamwidthDeg).toBe(60);
		expect(ap.aimDeg).toBe(0);

		ap.beamwidthDeg = 90;
		ap.aimDeg = 15;
		const next = addAp(20, 20);
		expect(next.beamwidthDeg).toBe(90);
		expect(next.aimDeg).toBe(15);
	});

	it('gives a 2.4 GHz access point the wider pattern measured for that band', () => {
		seedFloors();
		const ap = addAp(10, 10);
		ap.band = '2.4ghz';
		// A band change does not rewrite an antenna's numbers — they are the
		// hardware's — but a new AP on that band starts from the 2.4 GHz defaults.
		apState.aps = [];
		apState.band = '2.4ghz';
		expect(addAp(10, 10).beamwidthDeg).toBe(120);
	});

	it('carries the facing over, and takes one the caller measured', () => {
		seedFloors();
		const first = addAp(10, 10);
		first.mount = 'wall';
		first.mountHeightM = 1.5;
		first.facingDeg = 90;

		// A run of wall mounts along one wall inherits the direction of the last one.
		expect(addAp(20, 20).facingDeg).toBe(90);
		// But a wall the caller measured wins: placing on a wall knows better than
		// the previous unit did.
		expect(addAp(20, 20, 180).facingDeg).toBe(180);
	});

	it('starts unpinned, and does not inherit the pin from the last one', () => {
		seedFloors();
		const first = addAp(10, 10);
		expect(first.pinned).toBe(false);
		/*
		 * A new AP is the optimiser's to place. Carrying the pin over would silently
		 * freeze the next AP the user drops, which is the opposite of what pinning one
		 * AP is for.
		 */
		first.pinned = true;
		expect(addAp(20, 20).pinned).toBe(false);
	});
});

describe('the wall mount as an antenna', () => {
	it('gives a wall mount a horizontal cut and an upright omni none', () => {
		const wall = antennaProfileFor({
			band: '5ghz',
			beamwidthDeg: 60,
			aimDeg: 0,
			mount: 'wall',
			facingDeg: 90
		});
		expect(wall.facingDeg).toBe(90);
		expect(wall.azBeamwidthDeg).toBe(WALL_MOUNT_AZIMUTH.azBeamwidthDeg);
		expect(wall.frontToBackDb).toBe(WALL_MOUNT_AZIMUTH.frontToBackDb);

		for (const mount of ['ceiling', 'floor'] as const) {
			const omni = antennaProfileFor({
				band: '5ghz',
				beamwidthDeg: 60,
				aimDeg: 0,
				mount,
				facingDeg: 90
			});
			// No horizontal cut at all, so the model is what it was before wall
			// mounts existed — a facing on a ceiling mount is a field that does
			// nothing, not a pattern.
			expect(omni.azBeamwidthDeg).toBeUndefined();
			expect(azimuthLossDb(180, omni)).toBe(0);
			// Facing 90° in the plan, so 270° is straight behind it: the front-to-back
			// figure, and nothing like the 0 dB it would have had without a cut.
			expect(azimuthLossDb(270, wall)).toBeCloseTo(WALL_MOUNT_AZIMUTH.frontToBackDb, 6);
			// Sideways is between the two: this is a lobe, not a half-space switch.
			const side = azimuthLossDb(180, wall);
			expect(side).toBeGreaterThan(3);
			expect(side).toBeLessThan(WALL_MOUNT_AZIMUTH.frontToBackDb);
		}
	});

	it('is the preset the editor lists, at a bracket’s height', () => {
		expect(MOUNT_PRESETS.some((p) => p.mount === 'wall')).toBe(true);
		expect(defaultMountHeight('wall', 3)).toBeCloseTo(2, 6);
	});
});
