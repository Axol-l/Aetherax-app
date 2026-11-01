import { describe, expect, it, beforeEach } from 'vitest';
import { addAp, apState } from './ap-state.svelte.js';
import { floorState } from './floor-state.svelte.js';
import { coverageBasis, dropStaleCoverage, floorCoverage } from './optimizer-state.svelte.js';

/*
 * A coverage figure is a measurement of a *particular* plan.
 *
 * Nothing used to invalidate one: move a wall, delete an access point, undo either, and the
 * panel, the building mean and the PDF report kept printing the previous measurement — and
 * because the number was persisted with the document, a reload brought it back. `basis` is the
 * plan a figure describes; a figure whose basis no longer matches is dropped before the next
 * pass writes its own.
 */

function reseed() {
	floorState.floors = [];
	const floor = {
		id: 'floor-a',
		name: 'Floor 1',
		level: 0,
		ceilingHeight: 3,
		floorThickness: 0.2,
		floorMaterial: 1,
		floorplanUrl: null,
		floorplanScale: 0.4,
		floorplanOffsetX: 0,
		floorplanOffsetY: 0,
		calibration: { worldUnitsPerMeter: 40 },
		floorplanBoundary: null,
		wallMask: null,
		wallAttenuation: 5,
		wallMaterial: 0,
		materialMask: null,
		roomTypeMask: null,
		roomDensityOverrides: {},
		roomCustomLabels: {},
		planningArea: null,
		surfaces: []
	} as (typeof floorState.floors)[number];
	floorState.floors = [floor];
	floorState.currentFloorId = floor.id;
	apState.aps = [];
	floorCoverage.clear();
	return floor;
}

function walls(tag: string) {
	return { dataUrl: `data:image/png;base64,${tag}`, width: 8, height: 8, originX: 0, originY: 0 };
}

describe('coverage basis', () => {
	beforeEach(() => {
		reseed();
	});

	it('changes when an access point moves', () => {
		addAp(10, 10);
		const before = coverageBasis('floor-a');

		const ap = apState.aps[0]!;
		apState.aps = [{ ...ap, x: 40 }];

		expect(coverageBasis('floor-a')).not.toBe(before);
	});

	it('changes when the walls change, and when the plan slides', () => {
		const floor = floorState.floors[0]!;
		floor.wallMask = walls('A');
		const before = coverageBasis('floor-a');

		floor.wallMask = walls('B');
		const replaced = coverageBasis('floor-a');
		expect(replaced).not.toBe(before);

		floor.wallMask = { ...floor.wallMask!, originX: 20 };
		expect(coverageBasis('floor-a')).not.toBe(replaced);
	});

	it('is stable while nothing changes', () => {
		addAp(10, 10);
		floorState.floors[0]!.wallMask = walls('A');

		expect(coverageBasis('floor-a')).toBe(coverageBasis('floor-a'));
	});
});

describe('dropStaleCoverage', () => {
	beforeEach(() => {
		reseed();
	});

	it('keeps a figure that still describes the plan', () => {
		const basis = coverageBasis('floor-a');
		floorCoverage.set('floor-a', { coverage: 80, samples: 100, basis });

		dropStaleCoverage();

		expect(floorCoverage.get('floor-a')).toMatchObject({ coverage: 80, samples: 100 });
	});

	it('drops a figure after the plan it described changed', () => {
		const basis = coverageBasis('floor-a');
		floorCoverage.set('floor-a', { coverage: 80, samples: 100, basis });
		addAp(30, 30);

		dropStaleCoverage();

		expect(floorCoverage.has('floor-a')).toBe(false);
	});

	it('drops a figure that came back from a file', () => {
		// A restored document carries the number and its sample count, and no basis — it was
		// measured by a previous session against a plan this one has not verified.
		floorCoverage.set('floor-a', { coverage: 92, samples: 400 });

		dropStaleCoverage();

		expect(floorCoverage.has('floor-a')).toBe(false);
	});

	it('leaves a floor that has no figure alone', () => {
		dropStaleCoverage();
		expect(floorCoverage.size).toBe(0);
	});
});
