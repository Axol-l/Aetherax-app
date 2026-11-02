/**
 * Calibration is per floor.
 *
 * The project used to carry one scale: calibrating any storey wrote the value onto every
 * floor, and every consumer read floor 1's copy. That made a plan imported at a different
 * resolution unrepresentable — measuring floor 2 silently changed floor 1's metres — so
 * these tests pin the two halves of the new rule: a scale belongs to one floor, and adding
 * a floor copies the scale of the floor it was added from.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_WUPM,
	apState,
	getEffectiveWupm,
	radiusFromPower,
	wupmForFloor,
	type AccessPoint
} from './ap-state.svelte.js';
import { addFloor, floorState, type Floor } from './floor-state.svelte.js';
import { setFloorScale } from './floor-scale.js';

function floor(id: string, level: number, wupm: number | null): Floor {
	return {
		id,
		name: id,
		level,
		ceilingHeight: 3,
		floorMaterial: 1,
		floorThickness: 0.2,
		floorplanUrl: null,
		floorplanScale: 1,
		floorplanOffsetX: 0,
		floorplanOffsetY: 0,
		calibration: wupm === null ? null : { worldUnitsPerMeter: wupm },
		floorplanBoundary: null,
		wallMask: null,
		wallAttenuation: 5,
		wallMaterial: 0,
		materialMask: null,
		roomTypeMask: null,
		roomDensityOverrides: {},
		roomCustomLabels: {}
	};
}

function ap(id: string, floorId: string, interferenceRadius: number): AccessPoint {
	return {
		id,
		name: id,
		x: 10,
		y: 10,
		band: '5ghz',
		channelWidth: 20,
		fixedChannel: null,
		assignedChannel: null,
		interferenceRadius,
		power: 20,
		modelId: null,
		modelLabel: null,
		floorId,
		mount: 'ceiling',
		mountHeightM: 2.9,
		beamwidthDeg: 60,
		aimDeg: 0,
		facingDeg: 0,
		pinned: false
	};
}

function seed(): void {
	floorState.floors = [floor('f1', 0, 20), floor('f2', 1, 40)];
	floorState.currentFloorId = 'f1';
	apState.aps = [ap('a1', 'f1', 300), ap('a2', 'f2', 600)];
}

afterEach(() => {
	apState.aps = [];
	floorState.floors = [floor('f1', 0, null)];
	floorState.currentFloorId = 'f1';
});

describe('wupmForFloor', () => {
	it('reads each floor’s own scale, and the current floor through getEffectiveWupm', () => {
		seed();
		expect(wupmForFloor('f1')).toBe(20);
		expect(wupmForFloor('f2')).toBe(40);
		expect(getEffectiveWupm()).toBe(20);
		floorState.currentFloorId = 'f2';
		expect(getEffectiveWupm()).toBe(40);
	});

	it('falls back to the default for an uncalibrated floor, not to a sibling’s value', () => {
		seed();
		floorState.floors.push(floor('f3', 2, null));
		expect(wupmForFloor('f3')).toBe(DEFAULT_WUPM);
	});
});

describe('setFloorScale', () => {
	it('changes one floor and leaves the others’ scale and radii alone', () => {
		seed();
		setFloorScale('f1', 60);

		expect(floorState.floors[0]!.calibration).toEqual({ worldUnitsPerMeter: 60 });
		expect(floorState.floors[1]!.calibration).toEqual({ worldUnitsPerMeter: 40 });
		// f2's AP keeps its own units: calibrating f1 must not rewrite its reach.
		expect(apState.aps.find((a) => a.id === 'a2')!.interferenceRadius).toBe(600);
		// f1's AP is rescaled by the ratio 60/20, so its real reach is unchanged.
		expect(apState.aps.find((a) => a.id === 'a1')!.interferenceRadius).toBe(900);
	});

	it('promotes the uncalibrated radius on the first calibration of a floor', () => {
		seed();
		floorState.floors[0]!.calibration = null;
		const ap = apState.aps.find((a) => a.id === 'a1')!;
		ap.interferenceRadius = Math.round(15 * DEFAULT_WUPM);
		setFloorScale('f1', 50);
		expect(ap.interferenceRadius).toBe(Math.round(15 * 50));
	});

	it('refuses a scale that is not a positive number', () => {
		seed();
		setFloorScale('f1', Number.NaN);
		setFloorScale('f1', 0);
		expect(floorState.floors[0]!.calibration).toEqual({ worldUnitsPerMeter: 20 });
	});
});

describe('radiusFromPower', () => {
	it('can be told which floor’s units to use', () => {
		seed();
		expect(radiusFromPower(20, '5ghz', 40)).toBe(radiusFromPower(20, '5ghz', 20) * 2);
	});
});

describe('addFloor', () => {
	it('inherits the scale of the floor it was added from, not floor 1’s', () => {
		seed();
		floorState.currentFloorId = 'f2';
		const added = addFloor();
		expect(added.calibration).toEqual({ worldUnitsPerMeter: 40 });
	});
});
