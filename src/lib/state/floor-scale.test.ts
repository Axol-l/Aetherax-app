/**
 * 标定按楼层来。
 *
 * 以前项目只带一个比例：标定任何一层都会把值写到所有楼层，各处读的都是 1 层的副本 ——
 * 于是不同分辨率的图纸没法表达（量了 2 层，1 层的米数也被改）。这些测试盯住新规则的两半：
 * 比例只属于一个楼层；新增楼层时继承它加出来那一层的比例。
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
import { resampleRaster, scaleBetween, setFloorScale } from './floor-scale.js';

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
	it('reads each floor鈥檚 own scale, and the current floor through getEffectiveWupm', () => {
		seed();
		expect(wupmForFloor('f1')).toBe(20);
		expect(wupmForFloor('f2')).toBe(40);
		expect(getEffectiveWupm()).toBe(20);
		floorState.currentFloorId = 'f2';
		expect(getEffectiveWupm()).toBe(40);
	});

	it('falls back to the default for an uncalibrated floor, not to a sibling鈥檚 value', () => {
		seed();
		floorState.floors.push(floor('f3', 2, null));
		expect(wupmForFloor('f3')).toBe(DEFAULT_WUPM);
	});
});

describe('setFloorScale', () => {
	it('changes one floor and leaves the others鈥?scale and radii alone', () => {
		seed();
		setFloorScale('f1', 60);

		expect(floorState.floors[0]!.calibration).toEqual({ worldUnitsPerMeter: 60 });
		expect(floorState.floors[1]!.calibration).toEqual({ worldUnitsPerMeter: 40 });
		// f2 的 AP 用自己的单位：标定 f1 不能改它的覆盖范围。
		expect(apState.aps.find((a) => a.id === 'a2')!.interferenceRadius).toBe(600);
		// f1 的 AP 按 60/20 的比例缩放，所以实际覆盖没变。
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
	it('can be told which floor鈥檚 units to use', () => {
		seed();
		expect(radiusFromPower(20, '5ghz', 40)).toBe(radiusFromPower(20, '5ghz', 20) * 2);
	});
});

describe('addFloor', () => {
	it('inherits the scale of the floor it was added from, not floor 1鈥檚', () => {
		seed();
		floorState.currentFloorId = 'f2';
		const added = addFloor();
		expect(added.calibration).toEqual({ worldUnitsPerMeter: 40 });
	});
});


describe('scaleBetween', () => {
	it('converts a length from one floor’s units into another’s', () => {
		seed();
		expect(scaleBetween('f1', 'f2')).toBe(2);
		expect(scaleBetween('f2', 'f1')).toBe(0.5);
		expect(scaleBetween('f1', 'f1')).toBe(1);
	});
});

describe('resampleRaster', () => {
	it('keeps a mask readable across a factor-of-two calibration', () => {
		// 2x2：左上和右下是墙。
		const data = new Uint8Array([1, 0, 0, 1]);
		const out = resampleRaster(data, 2, 2, 2);
		expect(out.width).toBe(4);
		expect(out.height).toBe(4);
		// 左上那个源像素放大成 2x2 的墙。
		expect(out.data[0]).toBe(1);
		expect(out.data[5]).toBe(1);
		expect(out.data[2]).toBe(0);
	});

	it('returns the same raster at scale 1', () => {
		const data = new Uint8Array([1, 0, 0, 1]);
		const out = resampleRaster(data, 2, 2, 1);
		expect(out.data).toBe(data);
		expect(out.width).toBe(2);
	});
});
