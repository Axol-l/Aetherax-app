/**
 * The project document is the one shape a save, a restore, an export and an import all go
 * through, so it is the one place where "a field was forgotten" is a data-loss bug rather
 * than a cosmetic one.
 *
 * These tests exist because that is exactly what happened: `export/json.ts` had its own
 * copy of the schema, the copy never learned about vector walls, columns, raised surfaces,
 * notes or the planning area, and exporting then importing a project dropped them. The
 * round-trip test below is the guard: every field in the fixture has to survive
 * `migrate → applyDocument → toDocument`, or the suite fails.
 */
import { describe, expect, it } from 'vitest';
import type { AccessPoint } from './ap-state.svelte.js';
import { apState } from './ap-state.svelte.js';
import { floorState } from './floor-state.svelte.js';
import { floorplanState } from './floorplan-state.svelte.js';
import { canRedo, canUndo, pushState } from './history.svelte.js';
import { projectMeta } from './project-meta.svelte.js';
import { wallState } from './wall-state.svelte.js';
import {
	DOCUMENT_VERSION,
	applyDocument,
	isFromNewerVersion,
	migrate,
	toDocument,
	type FloorCoverageEntry,
	type ProjectDocumentV3
} from './project-document.js';

const FLOORPLAN = 'data:image/png;base64,FLOORPLAN';
const WALLS = 'data:image/png;base64,WALLS';

/** One project using every field the editor can write, so nothing can be dropped quietly. */
function fixture(): Record<string, unknown> {
	return {
		version: 3,
		name: 'Fixture',
		band: '5ghz',
		channelWidth: 40,
		regulatoryDomain: 'etsi',
		unitSystem: 'metric',
		ispSpeed: 500,
		targetThroughput: 50,
		allowOutsideRooms: true,
		heatmapRssiFloor: -72,
		clientHeight: 1.1,
		interferenceWeight: 0.35,
		coverageSoftnessDb: 8,
		coverageFloorPct: 90,
		coverageFloorEveryFloor: true,
		pathLossScenario: 'office',
		customMaterials: [
			{ id: 100, name: 'Lead door', dbPerCrossing: 30, thicknessM: 0.05, color: [10, 20, 30] }
		],
		floorCoverage: {
			'floor-a': { coverage: 87, samples: 400 },
			// A row for a floor the document does not have: a deleted floor's figure must
			// not come back as a phantom in the building mean.
			ghost: { coverage: 1, samples: 1 }
		},
		floors: [
			{
				id: 'floor-a',
				name: 'Ground',
				level: 0,
				ceilingHeight: 3.2,
				floorThickness: 0.25,
				floorMaterial: 2,
				floorplanImage: FLOORPLAN,
				floorplanScale: 0.5,
				floorplanOffsetX: 12,
				floorplanOffsetY: -4,
				calibration: { worldUnitsPerMeter: 40 },
				floorplanBoundary: [
					{ x: 0, y: 0 },
					{ x: 10, y: 0 },
					{ x: 10, y: 10 }
				],
				wallMask: { dataUrl: WALLS, width: 64, height: 48, originX: 5, originY: 6 },
				wallAttenuation: 7,
				wallMaterial: 2,
				materialMask: { dataUrl: 'data:image/png;base64,MAT', width: 64, height: 48 },
				roomTypeMask: { dataUrl: 'data:image/png;base64,ROOM', width: 64, height: 48 },
				roomDensityOverrides: { '1': 0.2 },
				roomCustomLabels: { '1': 'Lab' },
				planningArea: [
					{ x: 0, y: 0 },
					{ x: 100, y: 0 },
					{ x: 100, y: 100 }
				],
				notes: [{ id: 'n1', x: 5, y: 6, text: 'steel door' }],
				walls: [{ id: 'w1', ax: 0, ay: 0, bx: 10, by: 0, material: 3, heightM: 2.4 }],
				columns: [{ id: 'c1', shape: 'circle', ax: 5, ay: 5, bx: 6, by: 5, material: 1 }],
				surfaces: [
					{
						id: 's1',
						kind: 'ramp',
						ax: 0,
						ay: 0,
						bx: 20,
						by: 0,
						heightM: 0,
						topHeightM: 2,
						thicknessM: 0.2,
						attenuationDb: 12,
						solidBase: false
					}
				]
			},
			{
				id: 'floor-b',
				name: 'Upper',
				level: 1,
				ceilingHeight: 3,
				floorThickness: 0.2,
				floorMaterial: 1,
				floorplanScale: 0.5,
				floorplanOffsetX: 0,
				floorplanOffsetY: 0,
				calibration: { worldUnitsPerMeter: 40 },
				wallMask: null,
				wallAttenuation: 5,
				wallMaterial: 0,
				materialMask: null,
				roomTypeMask: null,
				roomDensityOverrides: {},
				roomCustomLabels: {},
				planningArea: null,
				notes: [],
				walls: [],
				columns: [],
				surfaces: []
			}
		],
		aps: [
			{
				id: 'ap-1',
				name: 'AP-1',
				x: 12.5,
				y: 33.25,
				band: '6ghz',
				channelWidth: 80,
				fixedChannel: 37,
				assignedChannel: 37,
				interferenceRadius: 900,
				power: 22,
				modelId: 'ubiquiti-u6-enterprise',
				modelLabel: 'U6 Enterprise',
				floorId: 'floor-a',
				mount: 'wall',
				mountHeightM: 2.1,
				beamwidthDeg: 60,
				aimDeg: -10,
				facingDeg: 135,
				pinned: true
			},
			{
				id: 'ap-2',
				name: 'AP-2',
				x: 40,
				y: 10,
				band: '5ghz',
				channelWidth: 40,
				fixedChannel: null,
				assignedChannel: 44,
				interferenceRadius: 700,
				power: 20,
				modelId: null,
				modelLabel: null,
				floorId: 'floor-b',
				mount: 'ceiling',
				mountHeightM: 2.9,
				beamwidthDeg: 90,
				aimDeg: 0,
				facingDeg: 0,
				pinned: false
			}
		]
	};
}

/** The underlay is a file-only field; everything else must match between the two sides. */
function withoutFloorplans(floors: ProjectDocumentV3['floors']) {
	return floors.map(({ floorplanImage: _image, ...rest }) => rest);
}

/** `applyDocument` re-derives radii from the propagation model, so they are compared apart. */
function withoutRadii(aps: AccessPoint[]) {
	return aps.map(({ interferenceRadius: _radius, ...rest }) => rest);
}

describe('project document', () => {
	it('keeps every field of a project through save and restore', () => {
		const first = migrate(fixture());
		expect(first).not.toBeNull();

		const coverage = new Map<string, FloorCoverageEntry>();
		applyDocument(first!, { floorCoverage: coverage });
		const written = toDocument({ floorCoverage: coverage });

		expect(written.version).toBe(DOCUMENT_VERSION);
		expect(written.name).toBe('Fixture');
		expect(written.unitSystem).toBe('metric');
		expect(written.pathLossScenario).toBe('office');
		expect(written.coverageFloorEveryFloor).toBe(true);

		// Floors and APs, field for field.
		expect(withoutFloorplans(written.floors)).toEqual(withoutFloorplans(first!.floors));
		expect(withoutRadii(written.aps)).toEqual(withoutRadii(first!.aps));

		// The fields the file format used to drop, named so a failure says which one.
		const floor = written.floors[0]!;
		expect(floor.walls).toEqual([
			{ id: 'w1', ax: 0, ay: 0, bx: 10, by: 0, material: 3, heightM: 2.4 }
		]);
		expect(floor.columns).toEqual([{ id: 'c1', shape: 'circle', ax: 5, ay: 5, bx: 6, by: 5, material: 1 }]);
		expect(floor.surfaces[0]?.topHeightM).toBe(2);
		expect(floor.notes).toEqual([{ id: 'n1', x: 5, y: 6, text: 'steel door' }]);
		expect(floor.planningArea).toHaveLength(3);
		expect(floor.wallMask).toEqual({ dataUrl: WALLS, width: 64, height: 48, originX: 5, originY: 6 });
		// A mask stored before masks carried an origin comes back at (0, 0).
		expect(floor.materialMask).toEqual({
			dataUrl: 'data:image/png;base64,MAT',
			width: 64,
			height: 48,
			originX: 0,
			originY: 0
		});

		// The other project-level fields.
		expect(written.customMaterials).toEqual([
			{ id: 100, name: 'Lead door', dbPerCrossing: 30, thicknessM: 0.05, color: [10, 20, 30] }
		]);
		/*
		 * Coverage is not carried: it is a measurement of the plan, not a property of the
		 * project. A file that carried it would print a figure for a building that no longer
		 * exists, and a reload would restore it as if it were data — see `toDocument` and
		 * `coverageBasis`.
		 */
		expect(written.floorCoverage).toEqual({});

		// The interface reads the underlay through the current floor.
		expect(floorState.floors[0]!.floorplanUrl).toBe(FLOORPLAN);
		expect(wallState.wallMask?.dataUrl).toBe(WALLS);
		expect(floorplanState.calibration?.worldUnitsPerMeter).toBe(40);
		expect(apState.aps).toHaveLength(2);
		expect(projectMeta.customMaterials).toHaveLength(1);
	});

	it('does not put the underlay into the stored document', () => {
		applyDocument(migrate(fixture())!);
		// Storage keeps the underlay under its own key; a save must not inline megabytes
		// of base64 into the project record.
		expect('floorplanImage' in toDocument().floors[0]!).toBe(false);
	});

	it('ends the undo history, so a snapshot cannot leak the previous project in', () => {
		applyDocument(migrate(fixture())!);
		// An edit worth undoing: the snapshot that follows belongs to *this* document.
		floorState.floors = [...floorState.floors, { ...floorState.floors[0]!, id: 'second' }];
		pushState();
		expect(canUndo()).toBe(true);

		// Opening another document must not leave that snapshot on the stack: undoing it
		// would put the first project's floors into the second project's name, band, units
		// and materials — a state that never existed, and one autosave would make permanent.
		applyDocument(migrate({ ...fixture(), name: 'Imported' })!);
		expect(canUndo()).toBe(false);
		expect(canRedo()).toBe(false);
	});

	it('upgrades a version 2 single-floor project', () => {
		const doc = migrate({
			version: 2,
			name: 'Old project',
			band: '2.4ghz',
			channelWidth: 20,
			regulatoryDomain: 'fcc',
			floorplanImage: 'data:image/png;base64,OLD',
			floorplanScale: 0.6,
			floorplanOffsetX: 3,
			wallMask: { dataUrl: WALLS, width: 32, height: 32 },
			wallAttenuation: 9,
			aps: [
				{
					id: 'old-ap',
					name: 'AP-1',
					x: 1,
					y: 2,
					band: '5ghz',
					channelWidth: 20,
					fixedChannel: null,
					assignedChannel: null,
					interferenceRadius: 150,
					power: 20
				}
			]
		});

		expect(doc).not.toBeNull();
		expect(doc!.version).toBe(DOCUMENT_VERSION);
		expect(doc!.floors).toHaveLength(1);
		const floor = doc!.floors[0]!;
		expect(floor.id).toBeTruthy();
		expect(floor.floorplanImage).toBe('data:image/png;base64,OLD');
		expect(floor.floorplanScale).toBe(0.6);
		expect(floor.wallAttenuation).toBe(9);
		expect(floor.wallMask?.originX).toBe(0);
		// Fields the old format never had arrive as the model it assumed.
		expect(floor.walls).toEqual([]);
		expect(floor.surfaces).toEqual([]);
		expect(floor.notes).toEqual([]);
		// The single floor is the AP's floor, and an AP with no mounting is on the ceiling.
		expect(doc!.aps[0]!.floorId).toBe(floor.id);
		expect(doc!.aps[0]!.mount).toBe('ceiling');
		expect(doc!.aps[0]!.pinned).toBe(false);
	});

	it('refuses a document it cannot read', () => {
		expect(migrate(null)).toBeNull();
		expect(migrate('not a project')).toBeNull();
		expect(migrate({})).toBeNull();
		expect(migrate({ version: 1 })).toBeNull();
		expect(migrate({ version: 3, floors: [] })).toBeNull();
	});

	/*
	 * A newer document is not a broken one.
	 *
	 * The two answers have to be distinguishable, because the callers act differently: a
	 * corrupt record is deleted from storage, a newer one is left alone and reported. Reading it
	 * with this build's field list and writing it back drops whatever the newer build added —
	 * silently, and on the user's only copy.
	 */
	it('refuses a document from a newer version, and says that is what it is', () => {
		const newer = { version: DOCUMENT_VERSION + 1, floors: [{ id: 'f1', name: 'F', level: 0 }] };
		expect(migrate(newer)).toBeNull();
		expect(isFromNewerVersion(newer)).toBe(true);

		// Everything this build can read is not "newer": the guard is the version, not the parse.
		expect(isFromNewerVersion({ version: DOCUMENT_VERSION })).toBe(false);
		expect(isFromNewerVersion({ version: 2 })).toBe(false);
		expect(isFromNewerVersion(null)).toBe(false);
		expect(isFromNewerVersion({ floors: [] })).toBe(false);
	});
});
