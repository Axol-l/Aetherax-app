/**
 * 3D 视图的换层动画：旧楼层先退场，新楼层再入场。
 *
 * 两段各占一半时长且不重叠，因此任一帧只画一层楼；下楼是上楼的方向镜像。
 * 位移距离取一层楼在屏幕上的投影高度，让动画读作「楼层在空间里上下移动」而不是翻页。
 * 绘制本身由 e2e 覆盖，这里只验证时序与几何。
 */
import { describe, expect, it } from 'vitest';
import {
	FLOOR_SWAP_MS,
	floorSwapDistancePx,
	floorSwapFrame,
	type FloorSwapMotion
} from './floor-3d.js';

const motion = (over: Partial<FloorSwapMotion> = {}): FloorSwapMotion => ({
	fromAlpha: 1,
	fromOffset: 0,
	direction: 1,
	distance: 40,
	...over
});

describe('floorSwapFrame', () => {
	it('fades the old floor out over the first half, then the new one in', () => {
		// 起点：旧楼层完整可见、没有偏移。
		expect(floorSwapFrame(0, motion())).toEqual({ phase: 'out', alpha: 1, offset: 0 });

		// 四分之一处：旧楼层半透明，并已向楼下走了一段。
		const quarter = floorSwapFrame(FLOOR_SWAP_MS / 4, motion());
		expect(quarter.phase).toBe('out');
		expect(quarter.alpha).toBeCloseTo(0.5, 9);
		expect(quarter.offset).toBeCloseTo(10, 9);

		// 中点：旧楼层已消失，新楼层从楼上的位置开始入场，因此偏移为负。
		const middle = floorSwapFrame(FLOOR_SWAP_MS / 2, motion());
		expect(middle.phase).toBe('in');
		expect(middle.alpha).toBe(0);
		expect(middle.offset).toBeCloseTo(-40, 9);

		// 四分之三处：新楼层半透明，正处在位移的中点，从上方落下的过程看得见。
		const threeQuarters = floorSwapFrame((FLOOR_SWAP_MS * 3) / 4, motion());
		expect(threeQuarters.phase).toBe('in');
		expect(threeQuarters.alpha).toBeCloseTo(0.5, 9);
		expect(threeQuarters.offset).toBeCloseTo(-20, 9);

		// 终点：新楼层完整就位。
		expect(floorSwapFrame(FLOOR_SWAP_MS, motion())).toEqual({
			phase: 'in',
			alpha: 1,
			offset: 0
		});
	});

	it('mirrors the movement when the storey change goes down', () => {
		const down = motion({ direction: -1 });
		const quarter = floorSwapFrame(FLOOR_SWAP_MS / 4, down);
		expect(quarter.phase).toBe('out');
		// 下楼时旧楼层向上退出，新楼层从下方升起。
		expect(quarter.offset).toBeCloseTo(-10, 9);
		expect(floorSwapFrame(FLOOR_SWAP_MS / 2, down).offset).toBeCloseTo(40, 9);
	});

	it('ends at the same place whatever the distance or direction', () => {
		for (const direction of [1, -1] as const) {
			for (const distance of [0, 20, 80]) {
				expect(floorSwapFrame(FLOOR_SWAP_MS, motion({ direction, distance }))).toEqual({
					phase: 'in',
					alpha: 1,
					offset: 0
				});
			}
		}
	});

	it('starts from where a retargeted floor was left', () => {
		// 连续按箭头时，退场的那层可能已经只剩一半：新一轮从它当前的值继续，而不是跳回不透明。
		const retarget = motion({ fromAlpha: 0.4, fromOffset: 12 });
		expect(floorSwapFrame(0, retarget)).toEqual({ phase: 'out', alpha: 0.4, offset: 12 });
		expect(floorSwapFrame(FLOOR_SWAP_MS / 4, retarget).alpha).toBeCloseTo(0.2, 9);
	});

	it('clamps elapsed time outside the animation', () => {
		// 负时间与超时都不该产生负透明度或越界偏移。
		expect(floorSwapFrame(-50, motion()).alpha).toBe(1);
		expect(floorSwapFrame(FLOOR_SWAP_MS * 4, motion())).toEqual({
			phase: 'in',
			alpha: 1,
			offset: 0
		});
	});

	it('splits the two halves at whatever duration it is given', () => {
		// 时长是参数而不是常量：测试与以后调整节奏都只用改一处。
		const short = motion({ distance: 20 });
		expect(floorSwapFrame(50, short, 200)).toEqual({ phase: 'out', alpha: 0.5, offset: 5 });
		expect(floorSwapFrame(100, short, 200)).toEqual({ phase: 'in', alpha: 0, offset: -20 });
	});
});

describe('floorSwapDistancePx', () => {
	it('is one storey projected by the camera', () => {
		// 3 m × 33 世界单位/米 × sin(30°) = 49.5 世界单位，缩放为 1 时就是 49.5 px。
		expect(floorSwapDistancePx(3, 33, Math.PI / 6, 1)).toBeCloseTo(49.5, 9);
		// 放大后位移随之变大，尚未触及上限。
		expect(floorSwapDistancePx(3, 33, Math.PI / 6, 1.5)).toBeCloseTo(74.25, 9);
	});

	it('stays within a range that reads as a storey, not a page turn', () => {
		// 接近俯视或极度缩小时不会退化成看不出方向的一两像素。
		expect(floorSwapDistancePx(0, 0, 0, 0)).toBe(20);
		// 大幅放大时也不会把楼层甩出画面。
		expect(floorSwapDistancePx(30, 1000, Math.PI / 2, 4)).toBe(80);
	});
});
