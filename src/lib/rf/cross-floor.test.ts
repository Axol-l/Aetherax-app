import { describe, expect, it } from 'vitest';
import { ROOM_TYPES } from '$lib/domain/room-types.js';
import {
	crossFloorLoss,
	crossFloorSegments,
	crossFloorSplit,
	floorPlaneCrossings,
	pointAlong,
	slabIsVoid
} from './cross-floor.js';

/**
 * 校验跨层射线的切分：按楼板把路径分成源楼层和目标楼层两段。
 * 同时锁定切分点几何，避免墙体损耗被记到错误楼层。
 */

/** 0、3、6 m 处的楼层平面（三层，每层 3 m）。 */
const PLANES = [0, 3, 6];

describe('crossFloorSplit', () => {
	it('puts the crossing two thirds along an adjacent-floor ray', () => {
		// AP 在 6 m（2 层顶板）、客户端在 1 层 1.5 m；两者之间的楼板在 3 m，即射线
		// (3 - 6) / (1.5 - 6) = 2/3 处。
		const { sourceT, targetT } = crossFloorSplit(6, 1.5, PLANES);
		expect(sourceT).toBeCloseTo(2 / 3, 10);
		expect(targetT).toBeCloseTo(2 / 3, 10);
	});

	it('finds both crossings when the ray passes a whole storey', () => {
		// 3 层 AP 到 1 层客户端：6 m 穿墙点在 0.4，3 m 穿墙点在 0.8。
		const { sourceT, targetT } = crossFloorSplit(9, 1.5, PLANES);
		expect(sourceT).toBeCloseTo(0.4, 10);
		expect(targetT).toBeCloseTo(0.8, 10);
	});

	it('does not split when the ray never leaves the client floor', () => {
		// 下方楼层的 AP 吊顶安装在客户端所在楼层平面上，因此整段射线都在客户端楼层内。
		// 平面虽在 t = 0 处被列为穿墙点（AP 上方楼板属于路径），但不切分任何一段。
		expect(crossFloorSplit(3, 4.5, PLANES)).toEqual({ sourceT: 0, targetT: 0 });
		// 同一楼层。
		expect(crossFloorSplit(1.5, 1.5, PLANES)).toEqual({ sourceT: 0, targetT: 0 });
		// 平面恰好位于 AP 或客户端时不算穿过。
		expect(crossFloorSplit(3, 3, PLANES)).toEqual({ sourceT: 0, targetT: 0 });
	});
});

/**
 * 校验每个穿墙点属于哪块楼板；份额必须归到正确的楼层边界，否则豁免会落到错误楼层。
 */
describe('floorPlaneCrossings', () => {
	it('names one slab for an adjacent-floor ray, and the same one the split uses', () => {
		// 2 层吊顶 AP（z = 6）、1 层客户端（z = 1.5）。
		const crossings = floorPlaneCrossings(6, 1.5, PLANES);
		expect(crossings).toHaveLength(1);
		// 3 m 是 1、2 层之间的边界。
		expect(crossings[0]!.planeZ).toBe(3);
		expect(crossings[0]!.planeIndex).toBe(1);
		// (3 - 6) / (1.5 - 6) = 2/3，切分的两端都落在这一穿墙点。
		expect(crossings[0]!.t).toBeCloseTo(2 / 3, 10);
		const { sourceT, targetT } = crossFloorSplit(6, 1.5, PLANES);
		expect(sourceT).toBeCloseTo(crossings[0]!.t, 10);
		expect(targetT).toBeCloseTo(crossings[0]!.t, 10);
	});

	it('lists both slabs of a two-storey gap, outermost first', () => {
		// 3 层吊顶 AP（z = 9）、1 层客户端（z = 1.5）。
		const crossings = floorPlaneCrossings(9, 1.5, PLANES);
		expect(crossings.map((c) => c.planeZ)).toEqual([6, 3]);
		// 6 m：(6 - 9) / (1.5 - 9) = 0.4；3 m：(3 - 9) / (1.5 - 9) = 0.8。
		expect(crossings[0]!.t).toBeCloseTo(0.4, 10);
		expect(crossings[1]!.t).toBeCloseTo(0.8, 10);
		expect(crossings.map((c) => c.planeIndex)).toEqual([2, 1]);
	});

	it('lists nothing for an upward adjacent-floor ray, whose only plane is at the AP', () => {
		// 1 层 AP（z = 3）向上到 2 层客户端（z = 4.5）：两层之间的平面是 3 m，恰好位于
		// AP 处。该楼板确实在路径中（AP 安装在其下方），但本函数列出的是切分点，而位于
		// AP 处的穿墙点无法切出任何一段。
		expect(floorPlaneCrossings(3, 4.5, PLANES)).toEqual([]);
		expect(floorPlaneCrossings(1.5, 1.5, PLANES)).toEqual([]);
	});
});

describe('pointAlong', () => {
	it('interpolates in both axes', () => {
		expect(pointAlong(0, 0, 100, 200, 0.5)).toEqual({ x: 50, y: 100 });
		expect(pointAlong(0, 0, 100, 200, 0)).toEqual({ x: 0, y: 0 });
		expect(pointAlong(0, 0, 100, 200, 1)).toEqual({ x: 100, y: 200 });
	});
});

describe('crossFloorSegments', () => {
	it('splits an adjacent-floor path at two thirds', () => {
		const { sourceT, targetT } = crossFloorSplit(6, 1.5, PLANES);
		const seg = crossFloorSegments(sourceT, targetT, 0, 0, 300, 0)!;
		expect(seg).not.toBeNull();
		expect(seg.source.from).toEqual({ x: 0, y: 0 });
		expect(seg.source.to.x).toBeCloseTo(200, 10);
		expect(seg.target.from.x).toBeCloseTo(200, 10);
		expect(seg.target.to).toEqual({ x: 300, y: 0 });
	});

	it('is null when there is nothing to split', () => {
		expect(crossFloorSegments(0, 0, 0, 0, 300, 0)).toBeNull();
	});
});

describe('crossFloorLoss', () => {
	/** 每层一道墙，位于给定 x，损耗为给定 dB。 */
	function wallLoss(byFloor: Record<'source' | 'target', { wallX: number; db: number }>) {
		return (
			floor: 'source' | 'target',
			from: { x: number; y: number },
			to: { x: number; y: number }
		): number => {
			const w = byFloor[floor];
			const crossed =
				(from.x < w.wallX && to.x >= w.wallX) || (to.x < w.wallX && from.x >= w.wallX);
			return crossed ? w.db : 0;
		};
	}

	it('charges each half of the run to the floor it passes through', () => {
		// 上层 AP 在 (0,0)、下层客户端在 (300,0)，穿墙点在 2/3 处即 x = 200：上层 x = 50
		// 的墙被穿过（5 dB），下层 x = 50 的墙位于穿墙点后方而未被射线遇到；旧模型会误计为 7 dB。
		const { sourceT, targetT } = crossFloorSplit(6, 1.5, PLANES);
		const seg = crossFloorSegments(sourceT, targetT, 0, 0, 300, 0)!;
		expect(
			crossFloorLoss(seg, wallLoss({ source: { wallX: 50, db: 5 }, target: { wallX: 50, db: 7 } }))
		).toBe(5);
	});

	it('adds a wall that only the client floor reaches', () => {
		const { sourceT, targetT } = crossFloorSplit(6, 1.5, PLANES);
		const seg = crossFloorSegments(sourceT, targetT, 0, 0, 300, 0)!;
		// 目标楼层：穿墙点后方有一道墙（x = 50，射线前缀中看不到），前方还有一道
		// （x = 250）；只有后者计入。
		expect(
			crossFloorLoss(seg, wallLoss({ source: { wallX: 50, db: 5 }, target: { wallX: 250, db: 3 } }))
		).toBe(5 + 3);
	});
});

/**
 * 中庭是楼板上的洞，射线经过时不会遇到混凝土；两层之间的楼板属于上层，
 * 因此调用方必须传入上层的房间类型掩码。
 */
describe('slabIsVoid', () => {
	const W = 10;
	const H = 10;
	/** 空洞的真实 id，确保测试不会与房间类型表脱节。 */
	const VOID_ID = ROOM_TYPES.find((t) => t.isVoid)!.id;
	/** 房间类型：空洞使用其真实 id，普通房间为 1。 */
	function roomTypes(voidFrom: number, voidTo: number): Uint8Array {
		const data = new Uint8Array(W * H).fill(1);
		for (let y = 0; y < H; y++) {
			for (let x = voidFrom; x <= voidTo; x++) data[y * W + x] = VOID_ID;
		}
		return data;
	}

	it('is true inside the hole and false beside it', () => {
		const data = roomTypes(2, 4);
		expect(slabIsVoid(data, W, H, 0, 0, 3, 5)).toBe(true);
		expect(slabIsVoid(data, W, H, 0, 0, 6, 5)).toBe(false);
	});

	it('respects the mask origin', () => {
		const data = roomTypes(2, 4);
		// 掩码从 100 开始时，空洞覆盖世界坐标 x 102..104。
		expect(slabIsVoid(data, W, H, 100, 100, 103, 105)).toBe(true);
		expect(slabIsVoid(data, W, H, 100, 100, 3, 5)).toBe(false);
	});

	it('is false outside the mask and with no room data at all', () => {
		const data = roomTypes(2, 4);
		expect(slabIsVoid(data, W, H, 0, 0, -5, 5)).toBe(false);
		expect(slabIsVoid(data, W, H, 0, 0, 50, 5)).toBe(false);
		expect(slabIsVoid(null, W, H, 0, 0, 3, 5)).toBe(false);
	});
});
