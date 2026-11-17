import { describe, expect, it } from 'vitest';
import { ROOM_TYPES, getRoomType, isVoidRoomType } from '$lib/domain/room-types.js';

/**
 * 房间类型 id 是对外的约定：工程文件把 id 存进房间类型掩码，所以 id 必须永久且唯一。
 * 这两个查找函数都只返回第一个匹配项，重复 id 会让标注落在错误的类型上。
 */
describe('ROOM_TYPES', () => {
	it('gives every room type a unique id', () => {
		const seen = new Map<number, string>();
		for (const t of ROOM_TYPES) {
			const previous = seen.get(t.id);
			expect(
				previous,
				`room type id ${t.id} is used by both "${previous}" and "${t.name}"`
			).toBeUndefined();
			seen.set(t.id, t.name);
		}
	});

	it('reserves id 0 for unassigned', () => {
		expect(ROOM_TYPES.some((t) => t.id === 0)).toBe(false);
		expect(getRoomType(0)).toBeUndefined();
	});

	it('keeps ids inside one byte, which is how they are stored', () => {
		// 掩码是一张 PNG，id 存在红通道里。
		for (const t of ROOM_TYPES) {
			expect(t.id, t.name).toBeGreaterThan(0);
			expect(t.id, t.name).toBeLessThanOrEqual(255);
		}
	});

	it('has exactly one void, and it is the one lookups find', () => {
		const voids = ROOM_TYPES.filter((t) => t.isVoid);
		expect(voids).toHaveLength(1);
		const id = voids[0]!.id;
		expect(isVoidRoomType(id)).toBe(true);
		expect(getRoomType(id)?.name).toBe('Void / Atrium');
		// 其他类型都不能被当成空洞。
		for (const t of ROOM_TYPES) {
			if (t.id === id) continue;
			expect(isVoidRoomType(t.id), t.name).toBe(false);
		}
	});
});
