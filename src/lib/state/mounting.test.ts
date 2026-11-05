/**
 * 安装几何：AP 挂在哪、多高，以及这会改变什么。
 *
 * 垂直方向的计算只在这一组函数里做，热力图、覆盖率、优化器载荷和 worker 都直接读它们，不自己算一遍。
 * AP 高度始终参与建模，不是两套模型二选一——天花板安装只是新建 AP 时的默认预设。
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

/** 两层楼，层高 3 m 和 2.5 m，其他状态清空。 */
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
		// 层高比吸顶下探距离还小时，AP 落在地面上而不是穿到楼板下面；
		// 比桌面还矮时也留在地面。
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
		// 0.8 m 的 AP 对 1.5 m 的终端差 0.7 m：同层路径也不是平的。
		expect(apVerticalOffsetTo({ floorId: 'f1', mountHeightM: 0.8 }, 'f1', 1.5)).toBeCloseTo(
			0.7,
			6
		);
		// 符号无所谓，只看距离。
		expect(apVerticalOffsetTo({ floorId: 'f1', mountHeightM: 2.9 }, 'f1', 1.5)).toBeCloseTo(
			1.4,
			6
		);
		// AP 在地面、终端在它上方，还是同样的 0.7 m。
		expect(apVerticalOffsetTo({ floorId: 'f1', mountHeightM: 2.2 }, 'f1', 1.5)).toBeCloseTo(
			0.7,
			6
		);
	});

	it('is the whole geometric gap to a client on another floor', () => {
		seedFloors();
		// 一层 AP 落地高 0.8 m，二层终端离二层地面 1.5 m（即离一层地面 3 m）：
		// 3 + 1.5 - 0.8 = 3.7 m。
		expect(apVerticalOffsetTo({ floorId: 'f1', mountHeightM: 0.8 }, 'f2', 1.5)).toBeCloseTo(
			3.7,
			6
		);
		// 一层吸顶：3 + 1.5 - 2.9 = 1.6 m，正是还没有高度概念时模型假设的安装高度。
		expect(apVerticalOffsetTo({ floorId: 'f1', mountHeightM: 2.9 }, 'f2', 1.5)).toBeCloseTo(
			1.6,
			6
		);
		// 从二层往下打到一层终端：AP 在 3 + 1.6 = 4.6，终端在 1.5。
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
		// 一层吸顶 AP 在 3 m，二层终端在 4.5 m：两点之间只有二层 3 m 那层楼板，
		// 而它正好是端点本身，所以不切。
		expect(apSplitFor({ floorId: 'f1', mountHeightM: 3 }, 'f2', 1.5)).toEqual({
			sourceT: 0,
			targetT: 0
		});
	});

	it('splits a floor-mounted path at the plane it crosses', () => {
		seedFloors();
		// 从 0.8 m 到 4.5 m，射线在 3 m 处穿过二层楼板，也就是走完 2.2/3.7 的位置。
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
		// 上一个 AP 是壁挂，继承下去的话下一个也会变成壁挂；工具栏的选择必须优先。
		const first = addAp(10, 10);
		first.mount = 'wall';
		first.mountHeightM = 1.5;

		const ceiling = addAp(20, 20, 0, 'ceiling');
		expect(ceiling.mount).toBe('ceiling');
		expect(ceiling.mountHeightM).toBeCloseTo(2.9, 6);

		const wall = addAp(30, 30, 90, 'wall');
		expect(wall.mount).toBe('wall');
		expect(wall.mountHeightM).toBeCloseTo(2, 6);
		// 壁挂时，调用方实测的朝向仍然优先。
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
		// 换频段不改写天线的参数——那是硬件决定的；但该频段上新建的 AP
		// 会从 2.4 GHz 的默认值起步。
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

		// 沿同一面墙连续壁挂，会沿用上一个的方向。
		expect(addAp(20, 20).facingDeg).toBe(90);
		// 但调用方实测的那面墙说了算：在墙上放置时，位置比上一个 AP 更可信。
		expect(addAp(20, 20, 180).facingDeg).toBe(180);
	});

	it('starts unpinned, and does not inherit the pin from the last one', () => {
		seedFloors();
		const first = addAp(10, 10);
		expect(first.pinned).toBe(false);
		/*
		 * 新 AP 是交给优化器去放的。把固定状态继承过来，会悄悄锁死用户下一个放下的 AP，
		 * 正好和「固定某一个 AP」的用意相反。
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
			// 完全没有水平方向图，模型就和壁挂出现之前一样——吸顶 AP 上的
			// 朝向只是个没人用的字段，不是方向图。
			expect(omni.azBeamwidthDeg).toBeUndefined();
			expect(azimuthLossDb(180, omni)).toBe(0);
			// 平面里朝向 90°，那 270° 就是正后方：衰减等于前后比，
			// 而不是没有方向图时的 0 dB。
			expect(azimuthLossDb(270, wall)).toBeCloseTo(WALL_MOUNT_AZIMUTH.frontToBackDb, 6);
			// 侧面介于两者之间：这是一个波瓣，不是非黑即白的遮挡开关。
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
