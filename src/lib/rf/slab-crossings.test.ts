import { describe, expect, it } from 'vitest';
import { ROOM_TYPES } from '$lib/domain/room-types.js';
import { slabLossFactor } from './cross-floor.js';
import { ADDITIONAL_FLOOR_DB, crossingSlabsFor, type FloorForSlab } from './slab-crossings.js';

/**
 * 校验跨层路径中哪个楼板被豁免、豁免多少：三层场景下统计各穿墙点的损失占比。
 * 6 m 穿墙点对应 2 层顶板，楼板洞口绘制在 3 层平面上。
 */

const VOID_ID = ROOM_TYPES.find((t) => t.isVoid)!.id;

/** 20 x 20 像素的房间类型网格，除可选的空洞矩形外均为 `Custom`。 */
function roomTypes(voidRect: { x0: number; y0: number; x1: number; y1: number } | null) {
	const data = new Uint8Array(20 * 20).fill(1);
	if (voidRect) {
		for (let y = voidRect.y0; y <= voidRect.y1; y++) {
			for (let x = voidRect.x0; x <= voidRect.x1; x++) data[y * 20 + x] = VOID_ID;
		}
	}
	return { roomTypes: data, width: 20, height: 20, originX: 0, originY: 0 };
}

/**
 * 三层场景：在 `voidLevels` 所含层级的平面上，于世界坐标 x 8..14 放置空洞矩形。
 * 每次只放在一个层级，避免所有穿墙点都是洞口而使豁免失去分辨力。
 */
function scene(voidLevels: readonly number[], slabDb = 15): FloorForSlab[] {
	return [0, 1, 2].map((level) => ({
		id: `f${level + 1}`,
		elevation: level * 3,
		ceilingHeight: 3,
		// 每层自身的楼板；本场景 1 层没有需要计费的下方楼层，因此损耗为 0。
		slabLossDb: level === 0 ? 0 : slabDb,
		slice: roomTypes(voidLevels.includes(level) ? { x0: 8, y0: 0, x1: 14, y1: 19 } : null)
	}));
}

const INPUT = (voidLevels: readonly number[], slabDb = 15) => ({
	floors: scene(voidLevels, slabDb),
	clientHeight: 1.5,
	band: '5ghz' as const
});

/**
 * 用每个穿墙点所检验楼层的平面来标记损失份额，便于定位出错的楼层。
 */
function byPlannedFloor(input: ReturnType<typeof INPUT>, ap: string, client: string) {
	const slabs = crossingSlabsFor(input, ap, client) ?? [];
	return slabs.map((s) => {
		const owner = input.floors.find((f) => f.slice.roomTypes === s.roomTypes)!;
		return [`${owner.id}@t${s.t.toFixed(2)}`, Number(s.lossShare.toFixed(4))] as [string, number];
	});
}

describe('crossingSlabsFor', () => {
	it('names both storey boundaries of a two-storey gap, with the right shares', () => {
		const slabs = crossingSlabsFor(INPUT([]), 'f3', 'f1')!;
		expect(slabs.map((s) => Number(s.t.toFixed(3)))).toEqual([0.4, 0.8]);
		// 最低计费层 15 dB 加上限幅后的 5 dB 增量，合计 20 dB；因此靠 AP 的穿墙点份额为
		// 0.25，靠客户端的为 0.75。
		expect(byPlannedFloor(INPUT([]), 'f3', 'f1')).toEqual([
			['f3@t0.40', 0.25],
			['f2@t0.80', 0.75]
		]);
		expect(slabs.reduce((sum, s) => sum + s.lossShare, 0)).toBeCloseTo(1, 10);
	});

	it('waives the boundary whose own plan carries the void', () => {
		// 垂直射线沿 x = 10 穿过空洞走廊，两个穿墙点都落在矩形内，因此哪个平面带空洞就豁免哪个份额。
		//
		// 3 层平面位于 6 m 穿墙点上方，对应 0.25 份额。
		expect(slabLossFactor(crossingSlabsFor(INPUT([2]), 'f3', 'f1')!, 10, 10, 10, 10)).toBeCloseTo(
			1 - 0.25,
			10
		);
		// 2 层平面位于 3 m 穿墙点上方，对应 0.75 份额。
		expect(slabLossFactor(crossingSlabsFor(INPUT([1]), 'f3', 'f1')!, 10, 10, 10, 10)).toBeCloseTo(
			1 - 0.75,
			10
		);
		// 最低层的平面不覆盖本路径中的任何楼板，因此在此绘制空洞不会豁免，材料归属与平面归属分属不同楼层。
		expect(slabLossFactor(crossingSlabsFor(INPUT([0]), 'f3', 'f1')!, 10, 10, 10, 10)).toBeCloseTo(
			1,
			10
		);
	});

	it('does not waive a boundary the ray only crosses obliquely', () => {
		// AP 在 x = 10、采样点在 x = 18：6 m 穿墙点（t = 0.4）落在矩形内，3 m 穿墙点
		// （t = 0.8）落在矩形外，因此 3 层空洞豁免而 2 层不豁免。
		expect(slabLossFactor(crossingSlabsFor(INPUT([2]), 'f3', 'f1')!, 10, 10, 18, 10)).toBeCloseTo(
			1 - 0.25,
			10
		);
		expect(slabLossFactor(crossingSlabsFor(INPUT([1]), 'f3', 'f1')!, 10, 10, 18, 10)).toBeCloseTo(
			1,
			10
		);
	});

	it('includes the slab an upward path crosses at the AP itself', () => {
		// 1 层吊顶 AP（z = 3）到 2 层客户端（z = 4.5）：射线在 t = 0、即 AP 处穿过 3 m 平面，因此该楼板属于路径。
		// 若只查找严格内部平面，这里找不到任何穿墙点，向上路径也就无法豁免空洞。
		const slabs = crossingSlabsFor(INPUT([1]), 'f1', 'f2')!;
		expect(slabs).toHaveLength(1);
		expect(slabs[0]!.t).toBeCloseTo(0, 10);
		// 计费层是 2 层，其自身楼板即 3 m 平面；本场景 1 层损耗为 0，因此 5 dB 上限全落在
		// 2 层，份额为 1。
		expect(slabs[0]!.lossShare).toBeCloseTo(1, 10);
		// 空洞绘制在 2 层平面（客户端所在层），而穿墙点位于 AP 位置：吊顶 AP 安装在其穿越的
		// 楼板下方，因此只有当 AP 落在空洞内时才豁免。沿走廊的射线整体豁免，从走廊外射入的
		// 射线则保留全部 5 dB。
		const inside = INPUT([1]);
		expect(slabLossFactor(crossingSlabsFor(inside, 'f1', 'f2')!, 10, 10, 10, 10)).toBeCloseTo(
			0,
			10
		);
		expect(slabLossFactor(crossingSlabsFor(inside, 'f1', 'f2')!, 18, 10, 10, 10)).toBeCloseTo(
			1,
			10
		);
	});

	it('spans both slabs of a two-storey gap when one endpoint is in the middle', () => {
		// 1 层 AP 到 3 层客户端：1、2 层计费，3 m 穿墙点在 t = 0、6 m 穿墙点在 0.667，
		// 因此 6 m 处承担全部聚合损耗，3 m 处得到上限增量。
		const slabs = crossingSlabsFor(INPUT([]), 'f1', 'f3')!;
		expect(slabs.map((s) => Number(s.t.toFixed(3)))).toEqual([0, 0.667]);
		expect(slabs.map((s) => Number(s.lossShare.toFixed(3)))).toEqual([0.75, 0.25]);
		// t = 0.667 对应 6 m 平面，其空洞绘制在 3 层平面。
		expect(byPlannedFloor(INPUT([]), 'f1', 'f3')).toEqual([
			['f2@t0.00', 0.75],
			['f3@t0.67', 0.25]
		]);
	});

	it('is the same all-or-nothing waiver as before when the gap is one storey, downward', () => {
		// 2 层 AP 到 1 层客户端只穿过一个平面：3 m 边界即 1 层自身楼板；空洞绘制在 2 层
		// 平面，也就是 AP 所在层。
		const slabs = crossingSlabsFor(INPUT([1]), 'f2', 'f1')!;
		expect(slabs).toHaveLength(1);
		expect(slabs[0]!.lossShare).toBeCloseTo(1, 10);
		// 穿墙点位于射线 (3 - 6) / (1.5 - 6) = 2/3 处。
		expect(slabs[0]!.t).toBeCloseTo(2 / 3, 10);
		expect(slabLossFactor(slabs, 10, 10, 10, 10)).toBeCloseTo(0, 10);
		// 若空洞改在 1 层（客户端所在层，拥有材料但不拥有绘制空洞的平面），则不会发生豁免。
		expect(slabLossFactor(crossingSlabsFor(INPUT([0]), 'f2', 'f1')!, 10, 10, 10, 10)).toBeCloseTo(
			1,
			10
		);
	});

	it('scales shares so that they always sum to the aggregate', () => {
		// 两块 15 dB 楼板：15 + 5 = 20，因此份额为 0.25 和 0.75，上限增量使两者之和
		// 等于路径计费值。
		expect(ADDITIONAL_FLOOR_DB).toBe(5);
		// 薄楼板使上限不起作用：两个边界的份额都是 8 dB 的 0.5。
		expect(byPlannedFloor(INPUT([], 4), 'f3', 'f1')).toEqual([
			['f3@t0.40', 0.5],
			['f2@t0.80', 0.5]
		]);
	});

	it('never lets a multiplier exceed 1, even with a nonsense thickness', () => {
		// 份额来自用户可输入的材料厚度，负厚度会产生负份额，使该穿墙点的空洞反而放大楼板
		// 损耗；`slabLossFactor` 在两端限幅，确保豁免只会减少损耗。
		const floors = scene([]);
		floors[2]!.slabLossDb = 20;
		floors[1]!.slabLossDb = -1;
		const slabs = crossingSlabsFor({ floors, clientHeight: 1.5, band: '5ghz' }, 'f3', 'f1')!;
		// 射线完全避开空洞矩形，因此没有任何豁免。
		expect(slabLossFactor(slabs, 18, 10, 18, 10)).toBeLessThanOrEqual(1);
		expect(slabLossFactor(slabs, 18, 10, 18, 10)).toBeGreaterThanOrEqual(0);
	});

	it('has nothing to test when the two paths share a floor', () => {
		expect(crossingSlabsFor(INPUT([1]), 'f1', 'f1')).toBeNull();
	});

	it('moves the crossings when the access point is not on the ceiling', () => {
		/*
		 * AP 安装高度决定射线斜率，因此同一世界点的空洞会沿射线落在不同位置；
		 * 本测试校验不同安装高度下的穿墙位置。
		 */
		// 吊顶安装：AP 在 9 m、客户端在 1.5 m，穿墙点为 0.4 和 0.8（同上）。
		const ceiling = crossingSlabsFor(INPUT([]), 'f3', 'f1')!;
		expect(ceiling.map((s) => Number(s.t.toFixed(3)))).toEqual([0.4, 0.8]);

		// 落地安装于 0.8 m（三层楼面以上 6.8 m），到 1.5 m 的客户端：同样两个平面在 0.15
		// 和 0.72 处相交；射线起点更低、更平缓，因此交点比吊顶射线更靠近客户端。
		const low = crossingSlabsFor({ ...INPUT([]), apHeightM: 0.8 }, 'f3', 'f1')!;
		expect(low.map((s) => Number(s.t.toFixed(3)))).toEqual([0.151, 0.717]);

		// 壁挂安装于 4.5 m（三层楼面以上 10.5 m）：6 m 平面在 (6 - 10.5) / (1.5 - 10.5) = 0.5、
		// 3 m 平面在 0.833 处相交；射线起点更高，因此交点比吊顶射线更远离客户端。
		const wall = crossingSlabsFor({ ...INPUT([]), apHeightM: 4.5 }, 'f3', 'f1')!;
		expect(wall.map((s) => Number(s.t.toFixed(3)))).toEqual([0.5, 0.833]);
		// 份额不变：它们由楼板损耗决定，与射线斜率无关。
		expect(wall.map((s) => Number(s.lossShare.toFixed(3)))).toEqual([0.25, 0.75]);
	});

	it('omitting the mount height is the ceiling-mounted path it always was', () => {
		const withoutHeight = crossingSlabsFor(INPUT([]), 'f3', 'f1')!;
		const withCeiling = crossingSlabsFor({ ...INPUT([]), apHeightM: 3 }, 'f3', 'f1')!;
		expect(withCeiling.map((s) => s.t)).toEqual(withoutHeight.map((s) => s.t));
	});
});
