/**
 * 把各角色缓冲合成为墙体掩码与材质掩码。
 * 两条关键规则在此固定：洞口保留在掩码内，且洞口的材质优先。
 */
import { describe, expect, it } from 'vitest';
import { composeRoleMasks, DOOR_MATERIAL, WINDOW_MATERIAL } from './vector-detect.js';
import { DEFAULT_MATERIAL } from '$lib/domain/materials.js';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('composeRoleMasks', () => {
	it('puts every role into the wall mask, because an opening is still a barrier', () => {
		// 把门从掩码中挖掉会让唯一入口是门的房间对外开放，
		// `computeBuildingInterior` 将找不到内部区域。
		const { wall } = composeRoleMasks(
			[
				{ material: null, pixels: bytes(1, 0, 0) },
				{ material: WINDOW_MATERIAL, pixels: bytes(0, 1, 0) },
				{ material: DOOR_MATERIAL, pixels: bytes(0, 0, 1) }
			],
			DEFAULT_MATERIAL
		);
		expect(Array.from(wall)).toEqual([1, 1, 1]);
	});

	it('paints each opening its own material and leaves plain walls on the default', () => {
		const { material } = composeRoleMasks(
			[
				{ material: null, pixels: bytes(1, 0, 0) },
				{ material: WINDOW_MATERIAL, pixels: bytes(0, 1, 0) },
				{ material: DOOR_MATERIAL, pixels: bytes(0, 0, 1) }
			],
			DEFAULT_MATERIAL
		);
		expect(Array.from(material)).toEqual([DEFAULT_MATERIAL, WINDOW_MATERIAL, DOOR_MATERIAL]);
	});

	it('leaves a pixel on the default material when nothing claims it', () => {
		const { wall, material } = composeRoleMasks([{ material: null, pixels: bytes(0, 0) }], 4);
		expect(Array.from(wall)).toEqual([0, 0]);
		expect(Array.from(material)).toEqual([4, 4]);
	});

	it('lets the opening win where a door is drawn over the wall it sits in', () => {
		// 常见情况：门扇与开启弧线都画在墙体上，两个缓冲区在相同像素上都有值。
		const { wall, material } = composeRoleMasks(
			[
				{ material: DOOR_MATERIAL, pixels: bytes(1, 1) },
				{ material: null, pixels: bytes(1, 1) }
			],
			DEFAULT_MATERIAL
		);
		expect(Array.from(wall)).toEqual([1, 1]);
		expect(Array.from(material)).toEqual([DOOR_MATERIAL, DOOR_MATERIAL]);
	});

	it('does not care which order the caller passes the roles in', () => {
		const wallFirst = composeRoleMasks(
			[
				{ material: null, pixels: bytes(1) },
				{ material: WINDOW_MATERIAL, pixels: bytes(1) }
			],
			DEFAULT_MATERIAL
		);
		const windowFirst = composeRoleMasks(
			[
				{ material: WINDOW_MATERIAL, pixels: bytes(1) },
				{ material: null, pixels: bytes(1) }
			],
			DEFAULT_MATERIAL
		);
		expect(Array.from(wallFirst.material)).toEqual(Array.from(windowFirst.material));
	});

	it('returns empty masks when there is nothing to compose', () => {
		const { wall, material } = composeRoleMasks([], DEFAULT_MATERIAL);
		expect(wall.length).toBe(0);
		expect(material.length).toBe(0);
	});
});
