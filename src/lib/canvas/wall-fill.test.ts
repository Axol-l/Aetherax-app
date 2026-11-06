/**
 * 画成两条描边的墙，在识别后应输出为实心带。
 * 两条描边之间的空腔由检测流程中的形态学闭运算填补，房间不受影响。
 */
import { describe, expect, it } from 'vitest';
import { dilateMask, erodeMask } from './morphology.js';

/** 检测器在给定半径下使用的闭运算。 */
function close(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
	return erodeMask(dilateMask(mask, w, h, radius), w, h, radius, 'solid');
}

function frame(w: number, h: number, x0: number, y0: number, x1: number, y1: number, thickness = 1) {
	const mask = new Uint8Array(w * h);
	for (let t = 0; t < thickness; t++) {
		for (let x = x0; x <= x1; x++) {
			mask[(y0 + t) * w + x] = 1;
			mask[(y1 - t) * w + x] = 1;
		}
		for (let y = y0; y <= y1; y++) {
			mask[y * w + x0 + t] = 1;
			mask[y * w + x1 - t] = 1;
		}
	}
	return mask;
}

function count(mask: Uint8Array): number {
	let n = 0;
	for (const v of mask) n += v ? 1 : 0;
	return n;
}

describe('closing the cavity inside a drawn wall', () => {
	it('fills the gap between two strokes of one wall', () => {
		// 相距四像素的墙体带：两条描边，中间为空。
		const w = 60;
		const h = 40;
		const mask = new Uint8Array(w * h);
		for (let x = 10; x < 50; x++) {
			mask[12 * w + x] = 1;
			mask[16 * w + x] = 1;
		}
		const before = count(mask);
		const after = count(close(mask, w, h, 3));
		// 空腔（高 3 px、宽 40 px）被填满，带体变为实心。
		expect(after).toBeGreaterThan(before + 100);
		for (let x = 10; x < 50; x++) expect(close(mask, w, h, 3)[14 * w + x]).toBe(1);
	});

	it('leaves a room alone', () => {
		// 60 x 40 的图纸，中间是 30 x 20 的房间轮廓。
		const mask = frame(60, 40, 15, 10, 45, 30);
		const closed = close(mask, 60, 40, 3);
		// 房间内部仍为空：闭运算无法跨越三十像素。
		expect(closed[20 * 60 + 30]).toBe(0);
		// 轮廓依然在原位。
		expect(closed[10 * 60 + 30]).toBe(1);
	});

	it('does not fatten a wall it does not need to fill', () => {
		// 实心三像素带：闭运算必须原样返回，否则掩码中每条墙都会按半径增厚，
		// 衰减计算会重复计入穿越。
		const w = 60;
		const h = 20;
		const mask = new Uint8Array(w * h);
		for (let y = 8; y <= 10; y++) for (let x = 10; x < 50; x++) mask[y * w + x] = 1;
		expect(count(close(mask, w, h, 3))).toBe(count(mask));
	});
});
