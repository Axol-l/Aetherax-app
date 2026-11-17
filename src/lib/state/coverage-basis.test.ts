import { describe, expect, it, beforeEach } from 'vitest';
import { addAp, apState } from './ap-state.svelte.js';
import { floorState } from './floor-state.svelte.js';
import { projectMeta } from './project-meta.svelte.js';
import { DEFAULT_SETTINGS } from './project-settings.js';
import {
	coverageBasis,
	dropStaleCoverage,
	floorCoverage,
	optimizerState,
	resultIsStale,
	scoringSettingsSignature
} from './optimizer-state.svelte.js';

/*
 * 覆盖率数字是*某一版*方案的测量结果。
 *
 * 以前没有任何东西会把它作废：挪一堵墙、删一个 AP、撤销其中任一步，面板、整栋平均和 PDF 报告
 * 还照印上一次的数字；而且数字是跟着文档存下来的，重新打开就又回来了。`basis` 就是这个数字
 * 描述的方案；等下一轮跑之前，对不上的旧数字会先被丢掉。
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
	// 设置是模块级状态，前一个用例改过就会影响下一个；每个用例都从默认值开始。
	Object.assign(projectMeta, DEFAULT_SETTINGS);
	optimizerState.lastRunAt = null;
	optimizerState.settingsAtRun = null;
	return floor;
}

function walls(tag: string) {
	return { dataUrl: `data:image/png;base64,${tag}`, width: 8, height: 8, originX: 0, originY: 0 };
}

describe('coverage basis', () => {
	beforeEach(() => {
		reseed();
	});

	it('changes when the antenna or its aim changes', () => {
		addAp(10, 10);
		const before = coverageBasis('floor-a');
		const ap = apState.aps[0]!;

		apState.aps = [{ ...ap, beamwidthDeg: 40 }];
		const narrower = coverageBasis('floor-a');
		expect(narrower).not.toBe(before);

		apState.aps = [{ ...apState.aps[0]!, horizontalBeamwidthDeg: 235, facingDeg: 90 }];
		expect(coverageBasis('floor-a')).not.toBe(narrower);

		apState.aps = [{ ...apState.aps[0]!, mountHeightM: 1.1 }];
		expect(coverageBasis('floor-a')).not.toBe(narrower);
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

	it('changes when a setting that the figure depends on changes', () => {
		addAp(10, 10);
		const before = coverageBasis('floor-a');

		// 门限改了，同一个覆盖率数字说的就是另一件事；客户高度同理，它改垂直距离。
		projectMeta.coverageThresholdDbm = -65;
		const threshold = coverageBasis('floor-a');
		expect(threshold).not.toBe(before);

		projectMeta.clientHeight = 1.1;
		expect(coverageBasis('floor-a')).not.toBe(threshold);
	});

	it('marks the last run stale once a scoring setting changes', () => {
		optimizerState.lastRunAt = 1;
		optimizerState.settingsAtRun = scoringSettingsSignature();
		expect(resultIsStale()).toBe(false);

		projectMeta.interferenceWeight = 0.5;
		expect(resultIsStale()).toBe(true);

		// 重跑会把签名刷新成当前设置，旧布局的标记随之消失。
		optimizerState.settingsAtRun = scoringSettingsSignature();
		expect(resultIsStale()).toBe(false);
	});

	it('reads the floor’s own calibration, not the selected floor’s', () => {
		const a = floorState.floors[0]!;
		const b = { ...a, id: 'floor-b', name: 'Floor 2', level: 1, calibration: { worldUnitsPerMeter: 80 } };
		floorState.floors = [a, b];
		floorState.currentFloorId = 'floor-a';

		const aBefore = coverageBasis('floor-a');
		const bBefore = coverageBasis('floor-b');
		// 重新标定二层只会改二层的 basis，一层不受影响。
		floorState.floors[1]!.calibration = { worldUnitsPerMeter: 60 };
		expect(coverageBasis('floor-b')).not.toBe(bBefore);
		expect(coverageBasis('floor-a')).toBe(aBefore);
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
		// 从文件恢复的文档带着数字和采样点数，但没有 basis——那是上一次会话对一版方案测的，
		// 这次还没核对过。
		floorCoverage.set('floor-a', { coverage: 92, samples: 400 });

		dropStaleCoverage();

		expect(floorCoverage.has('floor-a')).toBe(false);
	});

	it('leaves a floor that has no figure alone', () => {
		dropStaleCoverage();
		expect(floorCoverage.size).toBe(0);
	});
});
