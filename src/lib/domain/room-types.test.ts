import { describe, expect, it } from 'vitest';
import { ROOM_TYPES, getRoomType, isVoidRoomType } from '$lib/domain/room-types.js';

/**
 * Room type ids are the contract.
 *
 * A room type id is what a saved project stores inside its room type mask, so an
 * id is permanent and has to be unique. Neither was enforced, and `Void / Atrium`
 * was added as 40 — the id `Huddle Room` already had. `getRoomType` and
 * `isVoidRoomType` both return the *first* match, so a painted void came back as a
 * Huddle Room: 0.5 devices/m², the label "Huddle", and no hole anywhere in the
 * placement or propagation code. The feature was inert and nothing said so.
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
		// The mask is a PNG with the id in the red channel.
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
		// And no other type is reported as a hole.
		for (const t of ROOM_TYPES) {
			if (t.id === id) continue;
			expect(isVoidRoomType(t.id), t.name).toBe(false);
		}
	});
});
