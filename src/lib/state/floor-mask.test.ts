/**
 * 墙体掩码的访问口：所有内核都从这一个口子读楼层的墙。
 *
 * 「线段是模型」必须在这里做实，因为优化器的全楼层运行读的是*别层*，那层的掩码不会由画布
 * 重新推导。这条路径只是算术、不涉及画布，所以不用浏览器也能测。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { floorState, type Floor } from './floor-state.svelte.js';
import { wallState } from './wall-state.svelte.js';
import { getFloorMask, invalidateSolverMaskCache } from './floor-mask.js';

function floorWithWalls(over: Partial<Floor> = {}): Floor {
	return {
		id: 'f1',
		name: 'Floor 1',
		level: 0,
		ceilingHeight: 3,
		floorThickness: 0.2,
		floorMaterial: 1,
		floorplanUrl: null,
		floorplanScale: 1,
		floorplanOffsetX: 0,
		floorplanOffsetY: 0,
		calibration: { worldUnitsPerMeter: 10 },
		floorplanBoundary: null,
		wallMask: null,
		wallAttenuation: 5,
		wallMaterial: 0,
		materialMask: null,
		roomTypeMask: null,
		roomDensityOverrides: {},
		roomCustomLabels: {},
		planningArea: null,
		surfaces: [],
		walls: [
			{ id: 'w1', ax: 100, ay: 100, bx: 200, by: 100, material: 0 },
			{ id: 'w2', ax: 200, ay: 100, bx: 200, by: 180, material: 0 },
			{ id: 'w3', ax: 200, ay: 180, bx: 100, by: 180, material: 0 },
			{ id: 'w4', ax: 100, ay: 180, bx: 100, by: 100, material: 0 }
		],
		...over
	};
}

/** 按世界坐标取掩码上的一个像素。 */
function at(
	mask: { wallData: Uint8Array; width: number; height: number; originX: number; originY: number },
	x: number,
	y: number
): number {
	const px = Math.round(x) - mask.originX;
	const py = Math.round(y) - mask.originY;
	if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return -1;
	return mask.wallData[py * mask.width + px]!;
}

describe('getFloorMask', () => {
	beforeEach(() => {
		floorState.floors = [floorWithWalls()];
		floorState.currentFloorId = 'f1';
		wallState.wallMask = null;
		wallState.materialMask = null;
		wallState.roomTypeMask = null;
		invalidateSolverMaskCache();
	});

	it('derives the raster from the segments when the floor has no stored mask', async () => {
		const mask = await getFloorMask('f1');
		expect(mask).not.toBeNull();
		// 线段覆盖到的地方画成了墙，里面的房间没有。
		expect(at(mask!, 150, 100)).toBe(1);
		expect(at(mask!, 100, 140)).toBe(1);
		expect(at(mask!, 150, 140)).toBe(0);
		// 坐标系取线段自己的包围盒加带宽余量，不是整个世界：没有图纸的楼层没有别的东西
		// 可以定坐标系。
		expect(mask!.width).toBeGreaterThan(100);
		expect(mask!.width).toBeLessThan(200);
	});

	it('takes the stored mask as the frame when there is one', async () => {
		floorState.floors = [
			floorWithWalls({
				wallMask: { dataUrl: 'unused', width: 400, height: 300, originX: -50, originY: -20 }
			})
		];
		invalidateSolverMaskCache();
		const mask = await getFloorMask('f1');
		expect(mask!.width).toBe(400);
		expect(mask!.height).toBe(300);
		expect(mask!.originX).toBe(-50);
		expect(at(mask!, 150, 100)).toBe(1);
	});

	it('re-derives when the segments change, and not when nothing did', async () => {
		const first = await getFloorMask('f1');
		const again = await getFloorMask('f1');
		// 还是同一个数组对象：缓存就是为了拖覆盖率时不要反复栅格化。
		expect(again).toBe(first);

		const floor = floorState.floors[0]!;
		const moved = (floor.walls ?? []).map((wall) =>
			wall.id === 'w1' ? { ...wall, by: 100 + 20 } : wall
		);
		floor.walls = [...moved];
		const second = await getFloorMask('f1');
		expect(second).not.toBe(first);
		expect(at(second!, 150, 140)).toBe(0);
	});

	it('carries the material ids, so the wall material reaches the kernel', async () => {
		const floor = floorState.floors[0]!;
		floor.walls = (floor.walls ?? []).map((wall) => ({ ...wall, material: 3 }));
		const mask = await getFloorMask('f1');
		const px = Math.round(150) - mask!.originX;
		const py = Math.round(100) - mask!.originY;
		expect(mask!.materialMap![py * mask!.width + px]).toBe(3);
	});
});
