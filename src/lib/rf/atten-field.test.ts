import { describe, expect, it } from 'vitest';
import { getAttenField, invalidateAttenCache, lookupAtten } from './propagation.js';

/**
 * 校验衰减场缓存：键包含位置、半径、频段和标签，不同掩码或频段不会共享同一场。
 */

const W = 100;
const H = 100;
const AP_X = 10;
const AP_Y = 50;

/** 在 `wallX` 处有一道竖直墙的掩码。 */
function wallAt(wallX: number): Uint8Array {
	const data = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) data[y * W + wallX] = 1;
	return data;
}

describe('getAttenField cache tags', () => {
	it('keeps fields built from different masks apart', () => {
		invalidateAttenCache();
		const db = [5];
		const probe = { x: 90, y: 50 };
		const fieldFor = (mask: Uint8Array, tag: string) =>
			getAttenField(AP_X, AP_Y, 40, mask, W, H, null, db, 5, true, 0, 0, tag);

		const walled = fieldFor(wallAt(20), '5ghz:tgt');
		const empty = fieldFor(new Uint8Array(W * H), '5ghz:src');

		// 位置、半径、频段都相同，只有掩码和标签不同。
		expect(lookupAtten(walled, probe.x, probe.y)).toBe(5);
		expect(lookupAtten(empty, probe.x, probe.y)).toBe(0);
	});

	it('reuses a field for the same tag and position', () => {
		invalidateAttenCache();
		const db = [5];
		const mask = new Uint8Array(W * H);
		const first = getAttenField(AP_X, AP_Y, 40, mask, W, H, null, db, 5, true, 0, 0, 'a');
		const again = getAttenField(AP_X, AP_Y, 40, mask, W, H, null, db, 5, true, 0, 0, 'a');
		expect(again).toBe(first);
	});

	it('keeps bands apart even at the same position', () => {
		invalidateAttenCache();
		const probe = { x: 90, y: 50 };
		const mask = wallAt(20);
		// 同一量化单元内，2.4 GHz 的石膏板墙对比 5 GHz 的混凝土墙。
		const low = getAttenField(AP_X, AP_Y, 40, mask, W, H, null, [3], 3, true, 0, 0, '2.4ghz:tgt');
		const high = getAttenField(AP_X, AP_Y, 40, mask, W, H, null, [12], 12, true, 0, 0, '5ghz:tgt');
		expect(lookupAtten(low, probe.x, probe.y)).toBe(3);
		expect(lookupAtten(high, probe.x, probe.y)).toBe(12);
	});

	/**
	 * 两个楼层各一个 AP，位置相同；缓存键只含位置和半径，因此必须用标签区分掩码，
	 * 否则两个 AP 共享同一场，第二层会按第一层的墙计算。
	 */
	it('keeps two floors\u2019 fields apart when their APs share a cell', () => {
		invalidateAttenCache();
		const db = [5];
		const probe = { x: 90, y: 50 };
		const fieldFor = (mask: Uint8Array, tag: string) =>
			getAttenField(AP_X, AP_Y, 40, mask, W, H, null, db, 5, true, 0, 0, tag);

		// 两层的 AP 位于同一量化单元，半径也相同。
		const floor1 = fieldFor(new Uint8Array(W * H), '5ghz:tgt:floor:f1');
		const floor2 = fieldFor(wallAt(20), '5ghz:tgt:floor:f2');

		expect(lookupAtten(floor1, probe.x, probe.y)).toBe(0);
		expect(lookupAtten(floor2, probe.x, probe.y)).toBe(5);

		// 同时，每层仍复用各自的场。
		expect(fieldFor(new Uint8Array(W * H), '5ghz:tgt:floor:f1')).toBe(floor1);
	});
});

/**
 * 校验查表在切片之间插值，使墙影成为渐变而非一条切片宽的暗带。
 * 掩码只有一列墙像素，从 AP 看去只遮蔽很窄的角度范围；若取最近切片，热力图会画出带硬边的未着色虚线。
 */
describe('lookupAtten interpolates across a shadow boundary', () => {
	const AP = { x: 10, y: 50 };
	/** 仅在 x = 30、y = 50 处有一个墙像素：只有经过它的射线被遮挡。 */
	function pinWall(): Uint8Array {
		const mask = new Uint8Array(W * H);
		mask[50 * W + 30] = 1;
		return mask;
	}

	it('never steps by the full wall loss between neighbouring samples', () => {
		invalidateAttenCache();
		const db = [20];
		const field = getAttenField(AP.x, AP.y, 120, pinWall(), W, H, null, db, 20, true, 0, 0, 't');

		// 在固定半径上扫过一小段圆弧，越过被遮挡的方向。
		const radius = 60;
		let previous: number | null = null;
		let maxStep = 0;
		for (let i = -40; i <= 40; i++) {
			const theta = (i * Math.PI) / 18000; // 0.01° 步长
			const v = lookupAtten(field, AP.x + radius * Math.cos(theta), AP.y + radius * Math.sin(theta));
			if (previous !== null) maxStep = Math.max(maxStep, Math.abs(v - previous));
			previous = v;
		}
		// 取最近切片的查表会在相邻采样间跳变整个 20 dB。
		expect(maxStep).toBeLessThan(2);
	});

	it('still returns the full shadow close to the shadowed direction', () => {
		invalidateAttenCache();
		const db = [20];
		const field = getAttenField(AP.x, AP.y, 120, pinWall(), W, H, null, db, 20, true, 0, 0, 't');
		// 正对墙的方向，且已越过墙。
		expect(lookupAtten(field, 70, 50)).toBeCloseTo(20, 0);
		// 偏离该方向则没有衰减。
		expect(lookupAtten(field, 10, 110)).toBe(0);
	});
});
