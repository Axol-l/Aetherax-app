import { describe, expect, it } from 'vitest';
import { rayMarchWallAtten } from './propagation.js';

/**
 * 校验墙体步进对一次穿越的计费：按材质表计一份损耗，与绘制厚度无关。
 * 用例尺度与多楼层场景所用的一致（32.7 世界单位/米）。
 */

/** 平面图中的一道竖直墙：x 处宽 `thickness` 像素、贯通整个掩码的条带。 */
function wallBand(width: number, height: number, x0: number, thickness: number): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = x0; x < x0 + thickness; x++) mask[y * width + x] = 1;
	}
	return mask;
}

const W = 100;
const H = 100;
/** 材质表对测试材质一次穿越给出的损耗。 */
const CONCRETE_DB = 32;
const GLASS_DB = 105;

function march(
	mask: Uint8Array,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	opts: { stride?: number; materialMap?: Uint8Array | null; materialDb?: number[] } = {}
) {
	return rayMarchWallAtten(
		mask,
		W,
		H,
		opts.materialMap ?? null,
		opts.materialDb ?? [CONCRETE_DB, GLASS_DB],
		CONCRETE_DB,
		x0,
		y0,
		x1,
		y1,
		opts.stride ?? 1
	);
}

describe('what the wall march charges for a crossing', () => {
	it('charges the material table figure, whatever the drawn thickness is', () => {
		// 画成细线与画成厚板的同一道墙只算一道墙：损耗由材质表决定，绘制厚度不参与计算。
		const thin = wallBand(W, H, 47, 1);
		const thick = wallBand(W, H, 40, 14);
		expect(march(thin, 10, 50, 90, 50)).toBeCloseTo(CONCRETE_DB, 9);
		expect(march(thick, 10, 50, 90, 50)).toBeCloseTo(CONCRETE_DB, 9);
	});

	it('charges a crossing at 45° the same as one straight through', () => {
		// 斜穿与直穿计费相同：角度属于几何，不构成额外损耗。
		const mask = wallBand(W, H, 47, 6);
		const straight = march(mask, 10, 50, 90, 50);
		const diagonal = march(mask, 10, 10, 90, 90);
		expect(diagonal).toBeCloseTo(straight, 9);
		expect(diagonal).toBeCloseTo(CONCRETE_DB, 9);
	});

	it('charges each painted material segment once', () => {
		// 两种材质绘制的墙是两段标签，因此计两次；射线停留在单段内时只计一次，与画笔宽度无关。
		const mask = wallBand(W, H, 40, 14);
		const materialMap = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) {
			for (let x = 40; x < 47; x++) materialMap[y * W + x] = 1;
			for (let x = 47; x < 54; x++) materialMap[y * W + x] = 0;
		}
		expect(march(mask, 10, 50, 90, 50, { materialMap })).toBeCloseTo(CONCRETE_DB + GLASS_DB, 9);
		// 不提供材质图时每个墙体像素都是默认材质：一次穿越，一次计费。
		expect(march(mask, 10, 50, 90, 50)).toBeCloseTo(CONCRETE_DB, 9);
	});

	it('charges nothing for a zero-attenuation material', () => {
		// 虚拟隔断划分空间但不衰减：它在墙体掩码中必须被穿过，作为标注材质时则不计损耗。
		const mask = wallBand(W, H, 47, 6);
		const materialMap = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) for (let x = 47; x < 53; x++) materialMap[y * W + x] = 2;
		expect(march(mask, 10, 50, 90, 50, { materialMap, materialDb: [CONCRETE_DB, GLASS_DB, 0] })).toBe(
			0
		);
	});

	it('does not charge for a ray that never meets a wall, at any stride', () => {
		const mask = wallBand(W, H, 47, 6);
		expect(march(mask, 10, 10, 10, 90)).toBe(0);
		expect(march(mask, 10, 10, 10, 90, { stride: 3 })).toBe(0);
		// …且粗步长仍能发现踏入的墙体：6 px 宽的条带大于 3 px 步长，采样点不会跳过它。
		expect(march(mask, 10, 50, 90, 50, { stride: 3 })).toBeCloseTo(CONCRETE_DB, 9);
	});
});
