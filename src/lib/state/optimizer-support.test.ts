/**
 * 优化器载荷里的单位换算，按被测那一层自己的比例走，而不是屏幕上正显示的那层。
 *
 * 载荷里只有两处把米换成世界单位：同层路径的垂直落差，和 AP 到终端的垂直间距。
 * 以前读的是选中层的标定，整栋优化时每一层都会被套上用户当时碰巧在看的那层比例。
 */
import { describe, expect, it } from 'vitest';
import { floorState, type Floor } from './floor-state.svelte.js';
import { projectMeta } from './project-meta.svelte.js';
import { localVerticalDropFor, toApInput } from './optimizer-support.js';
import type { AccessPoint } from './ap-state.svelte.js';

function floor(id: string, level: number, wupm: number, ceilingHeight = 3): Floor {
	return {
		id,
		name: id,
		level,
		ceilingHeight,
		floorThickness: 0.2,
		floorMaterial: 1,
		floorplanUrl: null,
		floorplanScale: 1,
		floorplanOffsetX: 0,
		floorplanOffsetY: 0,
		calibration: { worldUnitsPerMeter: wupm },
		floorplanBoundary: null,
		wallMask: null,
		wallAttenuation: 5,
		wallMaterial: 0,
		materialMask: null,
		roomTypeMask: null,
		roomDensityOverrides: {},
		roomCustomLabels: {}
	};
}

const ap: AccessPoint = {
	id: 'ap1',
	name: 'AP-1',
	x: 10,
	y: 10,
	band: '5ghz',
	channelWidth: 20,
	fixedChannel: null,
	assignedChannel: null,
	interferenceRadius: 500,
	power: 20,
	modelId: null,
	modelLabel: null,
	floorId: 'f1',
	mount: 'ceiling',
	mountHeightM: 2.9,
	beamwidthDeg: 60,
	aimDeg: 0,
	facingDeg: 0,
	pinned: false
};

describe('per-floor conversion in the optimiser payload', () => {
	it('takes the same-floor vertical drop from that floor’s scale', () => {
		projectMeta.clientHeight = 1.5;
		expect(localVerticalDropFor(floor('f1', 0, 20))).toBeCloseTo(1.5 * 20, 6);
		expect(localVerticalDropFor(floor('f2', 1, 40, 2.5))).toBeCloseTo(1.0 * 40, 6);
	});

	it('takes the AP-to-client gap from the frame floor’s scale', () => {
		projectMeta.clientHeight = 1.5;
		floorState.floors = [floor('f1', 0, 20)];
		floorState.currentFloorId = 'f1';

		const frame = { originX: 0, originY: 0, floorId: 'f1' };
		expect(toApInput(ap, frame).verticalGap).toBeCloseTo((2.9 - 1.5) * 20, 6);

		// 同一个 AP，楼层后来被标定得细了一倍：实际间距没变，世界单位翻倍。
		floorState.floors = [floor('f1', 0, 40)];
		expect(toApInput(ap, frame).verticalGap).toBeCloseTo((2.9 - 1.5) * 40, 6);
	});
});
