/**
 * 只测文件往返：`serialize` → 文本 → `deserialize`。
 * 确认画出的几何、标注和规划区域能写进文件并原样读回。
 */
import { describe, expect, it } from 'vitest';
import { deserialize, serialize } from './json.js';
import { floorState } from '$state/floor-state.svelte.js';
import { applyDocument, migrate } from '$state/project-document.js';

const WALLS = [{ id: 'w1', ax: 0, ay: 0, bx: 10, by: 0, material: 1, heightM: 2.4 }];
const COLUMNS = [{ id: 'c1', shape: 'rect', ax: 1, ay: 1, bx: 2, by: 2, material: 1 }];
const SURFACES = [
	{ id: 's1', kind: 'platform', ax: 0, ay: 0, bx: 5, by: 5, heightM: 2, topHeightM: 2 }
];
const NOTES = [{ id: 'n1', x: 3, y: 4, text: 'steel door' }];
const PLANNING_AREA = [
	{ x: 0, y: 0 },
	{ x: 100, y: 0 },
	{ x: 100, y: 100 }
];

/** 带有需要往返校验字段的工程数据。 */
function project(): Record<string, unknown> {
	return {
		version: 3,
		name: 'File round trip',
		band: '5ghz',
		channelWidth: 20,
		regulatoryDomain: 'fcc',
		unitSystem: 'metric',
		floors: [
			{
				id: 'f1',
				name: 'Floor 1',
				level: 0,
				ceilingHeight: 3,
				floorThickness: 0.2,
				floorMaterial: 1,
				floorplanScale: 0.5,
				floorplanOffsetX: 0,
				floorplanOffsetY: 0,
				wallMask: null,
				wallAttenuation: 5,
				wallMaterial: 0,
				materialMask: null,
				roomTypeMask: null,
				roomDensityOverrides: {},
				roomCustomLabels: {},
				planningArea: PLANNING_AREA,
				notes: NOTES,
				walls: WALLS,
				columns: COLUMNS,
				surfaces: SURFACES
			}
		],
		aps: []
	};
}

/** 内容完全不同的工程，用来确认导入会整体替换。 */
function blankProject(): Record<string, unknown> {
	return {
		version: 3,
		name: 'Blank',
		band: '5ghz',
		channelWidth: 20,
		regulatoryDomain: 'fcc',
		unitSystem: 'imperial',
		floors: [
			{
				id: 'other',
				name: 'Other',
				level: 0,
				ceilingHeight: 3,
				floorThickness: 0.2,
				floorMaterial: 1,
				floorplanScale: 0.4,
				floorplanOffsetX: 0,
				floorplanOffsetY: 0,
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
		aps: []
	};
}

describe('project file', () => {
	it('keeps the drawn geometry through export and import', async () => {
		applyDocument(migrate(project())!);
		const text = await serialize();

		// 文件里必须写出这些字段，读回时才有内容可恢复。
		const written = JSON.parse(text) as { floors: Array<Record<string, unknown>> };
		expect(written.floors[0]!.walls).toEqual(WALLS);
		expect(written.floors[0]!.columns).toEqual(COLUMNS);
		expect(written.floors[0]!.surfaces).toEqual(SURFACES);
		expect(written.floors[0]!.notes).toEqual(NOTES);
		expect(written.floors[0]!.planningArea).toEqual(PLANNING_AREA);

		applyDocument(migrate(blankProject())!);
		deserialize(text);

		const floor = floorState.floors[0]!;
		expect(floor.walls).toEqual(WALLS);
		expect(floor.columns).toEqual(COLUMNS);
		expect(floor.surfaces).toEqual(SURFACES);
		expect(floor.notes).toEqual(NOTES);
		expect(floor.planningArea).toEqual(PLANNING_AREA);
	});

	it('rejects a file whose version it cannot read', () => {
		expect(() => deserialize('{"version":1}')).toThrow('Unsupported file version');
		expect(() => deserialize('not json')).toThrow('Invalid JSON file');
		expect(() => deserialize('{"version":3,"floors":[]}')).toThrow(
			'Invalid project file: no floors'
		);
	});
});
