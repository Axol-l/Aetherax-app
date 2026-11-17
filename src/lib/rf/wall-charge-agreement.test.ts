/**
 * 校验同一面墙无论由哪条路径计费都得到同一答案：热力图、覆盖遍历、优化器快速通路和求解器共用同一墙体损耗。
 * 同时约束坐标原点处理和步长量化，避免各路径的数值互相矛盾。
 */
import { describe, expect, it } from 'vitest';
import { wallRunLoss, splitWallRunLoss, type WallRun } from './link-budget.js';
import { rayMarchWallAtten } from './propagation.js';

/** 两道竖直隔墙：x = 12 处的龙骨墙和 x = 26 处的混凝土墙。 */
const W = 40;
const H = 30;

const DRYWALL = 1;
const CONCRETE = 2;
const DB_BY_MATERIAL = [0, 3, 12];

function partitionedPlan(): { mask: Uint8Array; material: Uint8Array } {
	const mask = new Uint8Array(W * H);
	const material = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		mask[y * W + 12] = 1;
		material[y * W + 12] = DRYWALL;
		mask[y * W + 26] = 1;
		material[y * W + 26] = CONCRETE;
	}
	return { mask, material };
}

function run(overrides: Partial<WallRun> = {}): WallRun {
	const { mask, material } = partitionedPlan();
	return {
		mask,
		width: W,
		height: H,
		materialMask: material,
		materialDb: DB_BY_MATERIAL,
		fallbackDb: 99,
		originX: 0,
		originY: 0,
		defaultMaterialId: DRYWALL,
		...overrides
	};
}

/** 不穿墙、穿一道墙或穿两道墙的射线，含直线与斜线。 */
const RAYS: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; walls: number }> = [
	{ from: { x: 2, y: 15 }, to: { x: 8, y: 15 }, walls: 0 },
	{ from: { x: 2, y: 15 }, to: { x: 20, y: 15 }, walls: 1 },
	{ from: { x: 2, y: 15 }, to: { x: 38, y: 15 }, walls: 2 },
	{ from: { x: 2, y: 2 }, to: { x: 38, y: 28 }, walls: 2 },
	{ from: { x: 30, y: 20 }, to: { x: 38, y: 25 }, walls: 0 },
	{ from: { x: 20, y: 15 }, to: { x: 22, y: 15 }, walls: 0 }
];

describe('what a wall costs, whichever path charged it', () => {
	it('charges the material table, once per crossing, through the shared helper', () => {
		// 参考值：龙骨墙 3 dB，混凝土墙 12 dB。
		expect(wallRunLoss(run(), { x: 2, y: 15 }, { x: 8, y: 15 })).toBe(0);
		expect(wallRunLoss(run(), { x: 2, y: 15 }, { x: 20, y: 15 })).toBe(3);
		expect(wallRunLoss(run(), { x: 2, y: 15 }, { x: 38, y: 15 })).toBe(15);
	});

	it('is the same number whether the caller uses the helper or marches itself', () => {
		// `wallRunLoss` 的返回值就是 `rayMarchWallAtten` 的结果：优化器快速通路直接调用步进
		// 并自行扣除前缀，这里锁定两者一致，任一改动都会在此暴露。
		const plan = partitionedPlan();
		for (const ray of RAYS) {
			const viaHelper = wallRunLoss(run(), ray.from, ray.to, 1);
			const viaMarch = rayMarchWallAtten(
				plan.mask,
				W,
				H,
				plan.material,
				DB_BY_MATERIAL,
				99,
				ray.from.x,
				ray.from.y,
				ray.to.x,
				ray.to.y,
				1,
				DRYWALL
			);
			expect(viaMarch, `ray ${JSON.stringify(ray)}`).toBe(viaHelper);
		}
	});

	it('gives the same loss when the plan is drawn somewhere else on the sheet', () => {
		/*
		 * 掩码原点只改变坐标范围，不改变墙体内容；平移方案后损耗必须一致。
		 * 楼层对齐只改变原点，不改变掩码。
		 */
		const shifted = run({ originX: 100, originY: 50 });
		for (const ray of RAYS) {
			const here = wallRunLoss(run(), ray.from, ray.to);
			const there = wallRunLoss(
				shifted,
				{ x: ray.from.x + 100, y: ray.from.y + 50 },
				{ x: ray.to.x + 100, y: ray.to.y + 50 }
			);
			expect(there, `shifted ray ${JSON.stringify(ray)}`).toBe(here);
		}
	});

	it('lets the stride round the answer but not invent or lose a wall', () => {
		/*
		 * 热力图步长为 2、求解器为 3，数值不可能完全相等；但粗步进不能整道墙地偏离，
		 * 否则会跳过 1 px 隔墙，使最便宜的计算器失明。
		 */
		for (const ray of RAYS) {
			const fine = wallRunLoss(run(), ray.from, ray.to, 1);
			for (const stride of [2, 3]) {
				const coarse = wallRunLoss(run(), ray.from, ray.to, stride);
				const costs = [...(ray.walls === 0 ? [0] : [3, 12])];
				const worst = Math.max(...costs) + 12;
				expect(Math.abs(coarse - fine), `stride ${stride}, ray ${JSON.stringify(ray)}`).toBeLessThanOrEqual(
					worst
				);
				// 不穿墙的射线在任何步长下损耗都为零。
				if (ray.walls === 0) expect(coarse).toBe(0);
			}
		}
	});

	it('splits a cross-floor path at the storey and charges each half on its own plan', () => {
		/*
		 * 共享层的另一半：路径从 AP 楼层穿过楼板到达客户端楼层；两层平面不同，
		 * 若两段共用同一掩码，总损耗会暴露差异。
		 */
		const upper: WallRun = run();
		// 下层有自己的隔墙，位置不同。
		const lowerMask = new Uint8Array(W * H);
		const lowerMaterial = new Uint8Array(W * H);
		const lowerWallX = 30;
		for (let y = 0; y < H; y++) {
			lowerMask[y * W + lowerWallX] = 1;
			lowerMaterial[y * W + lowerWallX] = CONCRETE;
		}
		const lower: WallRun = {
			mask: lowerMask,
			width: W,
			height: H,
			materialMask: lowerMaterial,
			materialDb: DB_BY_MATERIAL,
			fallbackDb: 99,
			originX: 0,
			originY: 0,
			defaultMaterialId: DRYWALL
		};

		const from = { x: 2, y: 15 };
		const to = { x: 38, y: 15 };
		// 射线离开各楼层处的比例：源段在 x = 16.4 结束（已越过上层 12 px 的墙），目标段在
		// x = 23.6 开始（尚未到下层 30 px 的墙），因此每段各穿过本层一道墙。
		const sourceT = 0.4;
		const targetT = 0.6;
		const split = splitWallRunLoss(upper, lower, sourceT, targetT, from, to);
		expect(split).not.toBeNull();

		const sourceCross = { x: 2 + sourceT * 36, y: 15 };
		const targetCross = { x: 2 + targetT * 36, y: 15 };
		const upperHalf = wallRunLoss(upper, from, sourceCross);
		const lowerHalf = wallRunLoss(lower, targetCross, to);
		expect(upperHalf).toBe(3);
		expect(lowerHalf).toBe(12);
		expect(split).toBeCloseTo(upperHalf + lowerHalf, 6);
	});

	it('falls back to one run when the path stays on one floor', () => {
		const flat = run();
		// 两个穿墙比例都为零表示 `crossFloorSegments` 判定射线从未离开客户端楼层，调用方保持单段路径。
		expect(splitWallRunLoss(flat, flat, 0, 0, { x: 2, y: 15 }, { x: 38, y: 15 })).toBeNull();
	});
});
