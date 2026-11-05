/**
 * 壁挂 AP 能贴到哪些墙上。
 *
 * 虚拟隔断只是建模用的线，不衰减任何东西，也没有可安装的表面，所以不能贴——否则朝向会从
 * 一条两边都辐射的线推出来。
 */
import { describe, expect, it } from 'vitest';
import { attachableWallMask } from './wall-snap.js';

/**
 * `WALL_MATERIALS` 里的 id：虚拟隔断就是那条在所有频段都不衰减的，
 * `isVirtualMaterial` 判的就是这个。
 */
const DRYWALL = 0;
const BRICK = 3;
const VIRTUAL_PARTITION = 6;

/** 一条 1x4 的窄带：石膏板、虚拟隔断、砖，还有一个地面像素。 */
function strip() {
	const wallData = new Uint8Array([1, 1, 1, 0, 1]);
	const materialMap = new Uint8Array([DRYWALL, VIRTUAL_PARTITION, BRICK, 0, DRYWALL]);
	return { wallData, materialMap };
}

describe('attachableWallMask', () => {
	it('keeps walls and drops virtual partitions', () => {
		const { wallData, materialMap } = strip();
		const attachable = attachableWallMask(wallData, materialMap, DRYWALL);
		expect([...attachable]).toEqual([1, 0, 1, 0, 1]);
	});

	it('reads the floor default for pixels the material mask does not cover', () => {
		const { wallData } = strip();
		// 完全没有材质掩码：每面墙都按楼层默认材质算，这正是还没刷材质的图纸的样子。
		expect([...attachableWallMask(wallData, null, DRYWALL)]).toEqual([...wallData]);
		// ……而默认材质*就是*虚拟隔断时，一面墙都贴不了。
		expect([...attachableWallMask(wallData, null, VIRTUAL_PARTITION)]).toEqual([...wallData]);
	});

	it('treats an uncovered wall pixel as the default material', () => {
		// 材质掩码比墙掩码小，或者没人刷的地方是 0 的情况：0 是石膏板，所以墙仍然可贴。
		const wallData = new Uint8Array([1, 1]);
		const materialMap = new Uint8Array([0, VIRTUAL_PARTITION]);
		expect([...attachableWallMask(wallData, materialMap, DRYWALL)]).toEqual([1, 0]);
	});
});
