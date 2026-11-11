/**
 * 工程文档是保存、恢复、导出、导入共用的唯一结构，所以这里「漏了个字段」是丢数据，不是小毛病。
 *
 * 这组测试就是吃过亏才有的：`export/json.ts` 曾自己抄了一份结构，那副本一直不知道矢量墙、柱子、
 * 抬升面、标注和规划区域，导出再导入就把它们弄没了。下面的往返测试是防线：fixture 里的每个字段
 * 都得熬过 `migrate → applyDocument → toDocument`。
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

/** 一个用上编辑器能写的所有字段的工程，谁也别想悄悄漏掉。 */
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
		coverageThresholdDbm: -68,
		clientHeight: 1.1,
		interferenceWeight: 0.35,
		coverageSoftnessDb: 8,
		coverageFloorPct: 90,
		pathLossScenario: 'office',
		customMaterials: [
			{ id: 100, name: 'Lead door', dbPerCrossing: 30, thicknessM: 0.05, color: [10, 20, 30] }
		],
		floorCoverage: {
			'floor-a': { coverage: 87, samples: 400 },
			// 一条文档里已经没有的楼层的记录：已删楼层的数字不能借尸还魂，
			// 混进整栋平均里。
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

/** 底图是只存文件的字段；其余字段两边必须完全一致。 */
function withoutFloorplans(floors: ProjectDocumentV3['floors']) {
	return floors.map(({ floorplanImage: _image, ...rest }) => rest);
}

/** `applyDocument` 会按传播模型重算半径，所以比较时先把半径去掉。 */
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
		expect(written.coverageThresholdDbm).toBe(-68);

		// 楼层和 AP，逐个字段对。
		expect(withoutFloorplans(written.floors)).toEqual(withoutFloorplans(first!.floors));
		expect(withoutRadii(written.aps)).toEqual(withoutRadii(first!.aps));

		// 文件格式以前会丢的字段，单独点名，挂了就知道是哪一个。
		const floor = written.floors[0]!;
		expect(floor.walls).toEqual([
			{ id: 'w1', ax: 0, ay: 0, bx: 10, by: 0, material: 3, heightM: 2.4 }
		]);
		expect(floor.columns).toEqual([{ id: 'c1', shape: 'circle', ax: 5, ay: 5, bx: 6, by: 5, material: 1 }]);
		expect(floor.surfaces[0]?.topHeightM).toBe(2);
		expect(floor.notes).toEqual([{ id: 'n1', x: 5, y: 6, text: 'steel door' }]);
		expect(floor.planningArea).toHaveLength(3);
		expect(floor.wallMask).toEqual({ dataUrl: WALLS, width: 64, height: 48, originX: 5, originY: 6 });
		// 掩码还没有原点字段时存下的数据，读回来原点是 (0, 0)。
		expect(floor.materialMask).toEqual({
			dataUrl: 'data:image/png;base64,MAT',
			width: 64,
			height: 48,
			originX: 0,
			originY: 0
		});

		// 其余工程级字段。
		expect(written.customMaterials).toEqual([
			{ id: 100, name: 'Lead door', dbPerCrossing: 30, thicknessM: 0.05, color: [10, 20, 30] }
		]);
		/*
		 * 覆盖率不写进文档：它是对方案的测量，不是工程的属性。写进去的话，文件会给一栋已经
		 * 不存在的楼印数字，重新打开还会把它当成数据恢复——见 `toDocument` 和 `coverageBasis`。
		 */
		expect(written.floorCoverage).toEqual({});

		// 界面通过当前楼层读到底图。
		expect(floorState.floors[0]!.floorplanUrl).toBe(FLOORPLAN);
		expect(wallState.wallMask?.dataUrl).toBe(WALLS);
		expect(floorplanState.calibration?.worldUnitsPerMeter).toBe(40);
		expect(apState.aps).toHaveLength(2);
		expect(projectMeta.customMaterials).toHaveLength(1);
	});

	it('does not put the underlay into the stored document', () => {
		applyDocument(migrate(fixture())!);
		// 底图存在自己的键下；保存时不能把几兆的 base64 塞进工程记录。
		expect('floorplanImage' in toDocument().floors[0]!).toBe(false);
	});

	it('ends the undo history, so a snapshot cannot leak the previous project in', () => {
		applyDocument(migrate(fixture())!);
		// 一次值得撤销的修改：之后的快照属于*这个*文档。
		floorState.floors = [...floorState.floors, { ...floorState.floors[0]!, id: 'second' }];
		pushState();
		expect(canUndo()).toBe(true);

		// 打开另一个文档不能把那个快照留在栈上：撤销它会把第一个工程的楼层塞进第二个工程
		// 的名称、频段、单位和材质里——一个从未存在过的状态，自动保存还会把它坐实。
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
		// 老格式从来没有的字段，按当时模型假设的值补上。
		expect(floor.walls).toEqual([]);
		expect(floor.surfaces).toEqual([]);
		expect(floor.notes).toEqual([]);
		// 单层工程就是 AP 所在的层；没写安装方式的 AP 算吸顶。
		expect(doc!.aps[0]!.floorId).toBe(floor.id);
		expect(doc!.aps[0]!.mount).toBe('ceiling');
		expect(doc!.aps[0]!.pinned).toBe(false);
	});

	/*
	 * 删掉的设置项还会出现在旧文件里。
	 *
	 * 读入端必须无视它们：老工程得照常打开，而且不能因为读进来又写回去，
	 * 就把已经删掉的字段复刻成默认值——那等于让一个不存在的设置活过升级。
	 */
	it('ignores project settings that no longer exist', () => {
		const doc = migrate({
			...fixture(),
			heatmapRssiFloor: -85,
			receiverPolarizationAngleDeg: 90,
			coverageFloorEveryFloor: true
		});

		expect(doc).not.toBeNull();
		expect('heatmapRssiFloor' in doc!).toBe(false);
		expect('receiverPolarizationAngleDeg' in doc!).toBe(false);
		expect('coverageFloorEveryFloor' in doc!).toBe(false);
		// 留下的门限照旧生效：热力图的下限现在由它推出来。
		expect(doc!.coverageThresholdDbm).toBe(-68);
	});

	it('refuses a document it cannot read', () => {
		expect(migrate(null)).toBeNull();
		expect(migrate('not a project')).toBeNull();
		expect(migrate({})).toBeNull();
		expect(migrate({ version: 1 })).toBeNull();
		expect(migrate({ version: 3, floors: [] })).toBeNull();
	});

	/*
	 * 版本更新的文档不等于坏文档。
	 *
	 * 这两种情况必须区分开，因为调用方处理方式不同：坏记录从存储里删掉，
	 * 新版本文档原样留着并提示用户。用当前版本的字段表读进来再写回去，
	 * 会丢掉新版本新增的东西——而且是悄悄地丢在用户唯一的那份上。
	 */
	it('refuses a document from a newer version, and says that is what it is', () => {
		const newer = { version: DOCUMENT_VERSION + 1, floors: [{ id: 'f1', name: 'F', level: 0 }] };
		expect(migrate(newer)).toBeNull();
		expect(isFromNewerVersion(newer)).toBe(true);

		// 当前版本读得懂的一律不算「更新版本」：判据是版本号，不是解析结果。
		expect(isFromNewerVersion({ version: DOCUMENT_VERSION })).toBe(false);
		expect(isFromNewerVersion({ version: 2 })).toBe(false);
		expect(isFromNewerVersion(null)).toBe(false);
		expect(isFromNewerVersion({ floors: [] })).toBe(false);
	});
});
