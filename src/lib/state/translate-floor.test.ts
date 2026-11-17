/**
 * 平移一层楼，要把这一层上的东西全带上。
 *
 * 层间对齐就是一次刚体平移。以前它只挪底图偏移和三张掩码，把墙体*线段*留在原地；而掩码现在是
 * 由线段推导的，下一次推导又把墙放回去了：拖动一松手楼层弹回原位，按线段绘制的堆叠/三维视图干脆没动。
 * 这些测试把整层都钉住，几何数据也算在内。
 */
import { describe, expect, it } from 'vitest';
import { addFloor, getFloor, translateFloor } from './floor-state.svelte.js';

function seedFloor() {
	const floor = addFloor('Test floor');
	floor.walls = [
		{ id: 'w1', ax: 10, ay: 20, bx: 110, by: 20, material: 0 },
		{ id: 'w2', ax: 110, ay: 20, bx: 110, by: 120, material: 3 }
	] as never;
	floor.columns = [{ id: 'c1', shape: 'circle', ax: 50, ay: 50, bx: 70, by: 50, material: 4 }] as never;
	floor.planningArea = [
		{ x: 0, y: 0 },
		{ x: 200, y: 0 },
		{ x: 200, y: 200 }
	];
	floor.surfaces = [{
		id: 's1',
		kind: 'platform',
		ax: 10,
		ay: 10,
		bx: 60,
		by: 60,
		heightM: 2,
		topHeightM: 2
	}] as never;
	floor.notes = [{ id: 'n1', x: 5, y: 6, text: 'here' }] as never;
	return floor;
}

describe('translateFloor', () => {
	it('moves the segments, so the derived mask cannot undo it', () => {
		const floor = seedFloor();
		const before = floor.walls;
		translateFloor(floor.id, 30, -40, []);
		const moved = getFloor(floor.id)!;

		expect(moved.walls?.[0]).toMatchObject({ ax: 40, ay: -20, bx: 140, by: -20 });
		expect(moved.walls?.[1]).toMatchObject({ ax: 140, ay: -20, bx: 140, by: 80 });
		// 必须是新数组：推导掩码的缓存按数组引用做键，原地改会让缓存留着平移前的掩码。
		expect(moved.walls).not.toBe(before);
	});

	it('moves the columns, the planning area, the raised surfaces and the notes', () => {
		const floor = seedFloor();
		translateFloor(floor.id, 5, 7, []);
		const moved = getFloor(floor.id)!;

		expect(moved.columns?.[0]).toMatchObject({ ax: 55, ay: 57, bx: 75, by: 57 });
		expect(moved.planningArea?.[0]).toMatchObject({ x: 5, y: 7 });
		expect(moved.planningArea?.[2]).toMatchObject({ x: 205, y: 207 });
		expect(moved.surfaces?.[0]).toMatchObject({ ax: 15, ay: 17, bx: 65, by: 67 });
		expect(moved.notes?.[0]).toMatchObject({ x: 10, y: 13 });
	});

	it('moves the APs on this floor only, and the floorplan offset with them', () => {
		const floor = seedFloor();
		const other = addFloor('Other');
		const aps = [
			{ id: 'a1', floorId: floor.id, x: 100, y: 100 },
			{ id: 'a2', floorId: other.id, x: 100, y: 100 }
		];
		translateFloor(floor.id, 10, 10, aps);

		expect(aps[0]).toMatchObject({ x: 110, y: 110 });
		expect(aps[1]).toMatchObject({ x: 100, y: 100 });
		expect(getFloor(floor.id)!.floorplanOffsetX).toBe(10);
		expect(getFloor(floor.id)!.floorplanOffsetY).toBe(10);
	});

	it('moves the masks as new objects, so every derived cache notices', () => {
		const floor = seedFloor();
		floor.wallMask = { dataUrl: 'data:image/png;base64,A', width: 4, height: 4, originX: 1, originY: 2 };
		floor.materialMask = { dataUrl: 'data:image/png;base64,B', width: 4, height: 4, originX: 1, originY: 2 };
		const before = floor.wallMask;

		translateFloor(floor.id, 20, -5, []);
		const moved = getFloor(floor.id)!;

		expect(moved.wallMask).toMatchObject({ originX: 21, originY: -3 });
		expect(moved.materialMask).toMatchObject({ originX: 21, originY: -3 });
		/*
		 * 原点被写进了由掩码推导出的每个字段和室内范围，而那些缓存是按掩码的引用做键的——
		 * 所以原地平移的掩码，在所有缓存眼里还是平移前那张。这就是「热力图跟着楼层走」
		 * 和「热力图还留在旧坐标系」的区别。
		 */
		expect(moved.wallMask).not.toBe(before);
		expect(before).toMatchObject({ originX: 1, originY: 2 });
	});

	it('does nothing for a zero delta', () => {
		const floor = seedFloor();
		const before = floor.walls;
		translateFloor(floor.id, 0, 0, []);
		// 提前返回保住了数组引用，下游就不会白算一遍。
		expect(getFloor(floor.id)!.walls).toBe(before);
	});
});
