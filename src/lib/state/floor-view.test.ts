/**
 * 当前楼层视图的约定：`wallState` 和 `floorplanState` 不是当前楼层的副本，它们就是当前楼层 ——
 * 写会落到楼层上，读会跟着选中的楼层走。
 *
 * 正因为这样，才删掉了五处手写的同样九行赋值（保存、恢复、切楼层、撤销、导入）：副本会忘，视图不会过期。
 * 这些断言只关心两个方向，不针对某个具体调用方。
 */
import { describe, expect, it } from 'vitest';
import { addFloor, floorState, switchFloor } from './floor-state.svelte.js';
import { floorplanState } from './floorplan-state.svelte.js';
import { wallState } from './wall-state.svelte.js';

describe('current-floor view', () => {
	it('writes through to the floor that is selected', () => {
		const floor = floorState.floors[0]!;
		const mask = { dataUrl: 'data:image/png;base64,AA', width: 4, height: 4, originX: 1, originY: 2 };

		wallState.wallMask = mask;
		wallState.wallAttenuation = 9;
		wallState.wallMaterial = 3;
		floorplanState.calibration = { worldUnitsPerMeter: 40 };
		floorplanState.floorplanScale = 0.5;
		floorplanState.floorplanUrl = 'blob:underlay';

		expect(floor.wallMask).toEqual(mask);
		expect(floor.wallAttenuation).toBe(9);
		expect(floor.wallMaterial).toBe(3);
		expect(floor.calibration).toEqual({ worldUnitsPerMeter: 40 });
		expect(floor.floorplanScale).toBe(0.5);
		expect(floor.floorplanUrl).toBe('blob:underlay');
	});

	it('follows a floor switch, in both directions', () => {
		const first = floorState.floors[0]!;
		wallState.wallAttenuation = 4;
		floorplanState.floorplanBoundary = [{ x: 0, y: 0 }];

		const second = addFloor('Upper');
		switchFloor(second.id);

		// 新楼层读出来是它自己的值，不是屏幕上原来那层的。
		expect(wallState.wallAttenuation).toBe(5);
		expect(floorplanState.floorplanBoundary).toBeNull();

		wallState.wallAttenuation = 11;
		expect(second.wallAttenuation).toBe(11);
		expect(first.wallAttenuation).toBe(4);

		// 切回来读到的是第一层的值，不是第二层的。
		switchFloor(first.id);
		expect(wallState.wallAttenuation).toBe(4);
	});
});
