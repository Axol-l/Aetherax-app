/**
 * 校验镜像源几何：选取无需运行即可直接判断结果的情形。
 */
import { describe, expect, it } from 'vitest';
import { bestReflection, reflectionPowerRatio, reflections, specularReflection } from './reflection.js';

/** x = 100 处、y ∈ [0, 200] 的竖直混凝土墙（材质 id 4）。 */
const wall = { ax: 100, ay: 0, bx: 100, by: 200, material: 4 };

describe('specularReflection', () => {
	it('bounces halfway for points at equal distances, and the path is longer than direct', () => {
		// 两端都在墙的左侧时，镜面反弹点位于墙的中点。
		const from = { x: 0, y: 100 };
		const to = { x: 60, y: 100 };
		const hit = specularReflection(from, to, wall)!;
		expect(hit).not.toBeNull();
		expect(hit.x).toBeCloseTo(100, 6);
		expect(hit.y).toBeCloseTo(100, 6);
		expect(hit.cosTheta).toBeCloseTo(1, 6);
		expect(hit.length).toBeCloseTo(140, 6);
	});

	it('keeps the angle equal on both sides, with the bounce off centre', () => {
		// 只有两端位于墙的同一侧时才会存在反射。
		const tall = { ax: 100, ay: 0, bx: 100, by: 600, material: 4 };
		const from = { x: 0, y: 50 };
		const to = { x: 60, y: 550 };
		const hit = specularReflection(from, to, tall)!;
		expect(hit.x).toBeCloseTo(100, 6);
		// 镜像源 (200, 50) 与 x = 60 处接收点的连线交点。
		const t = (100 - 200) / (60 - 200);
		expect(hit.y).toBeCloseTo(50 + 500 * t, 6);
		// 两段路径与墙法线的夹角相等。
		const left = Math.atan2(Math.abs(hit.y - from.y), Math.abs(hit.x - from.x));
		const right = Math.atan2(Math.abs(to.y - hit.y), Math.abs(to.x - hit.x));
		expect(left).toBeCloseTo(right, 6);
		// 总路径是两段之和，长于直达路径。
		expect(hit.length).toBeGreaterThan(Math.hypot(to.x - from.x, to.y - from.y));
	});

	it('refuses a reflection between two points on opposite sides of the wall', () => {
		// 这条射线穿过墙；计费的是透射，不是反射。
		expect(specularReflection({ x: 10, y: 100 }, { x: 120, y: 100 }, wall)).toBeNull();
	});

	it('refuses a bounce beyond the end of a finite wall', () => {
		// 这些点的镜面反射点远在 y = 0 以下，落在墙段之外。
		expect(specularReflection({ x: 0, y: 400 }, { x: 200, y: 420 }, wall)).toBeNull();
	});

	it('refuses a degenerate wall', () => {
		expect(
			specularReflection({ x: 0, y: 0 }, { x: 10, y: 0 }, { ax: 5, ay: 5, bx: 5, by: 5, material: 4 })
		).toBeNull();
	});
});

describe('reflectionPowerRatio', () => {
	it('is large for concrete at a grazing angle and smaller head-on', () => {
		const headOn = reflectionPowerRatio(wall, '5ghz', 1);
		const grazing = reflectionPowerRatio(wall, '5ghz', 0.1);
		expect(headOn).toBeGreaterThan(0);
		expect(headOn).toBeLessThan(0.98);
		expect(grazing).toBeGreaterThan(headOn);
	});

	it('is zero for a material that is not a surface (virtual partition)', () => {
		expect(reflectionPowerRatio({ ...wall, material: 6 }, '5ghz', 1)).toBe(0);
		expect(reflectionPowerRatio({ ...wall, material: 7 }, '5ghz', 1)).toBe(0);
	});

	it('reflects a 10 mm glass pane more at 2.4 GHz than at 6.5', () => {
		// 让玻璃在低频更像“好墙”的物理规律，也让它在低频更像镜子：玻璃厚度占波长的比例更大。
		const low = reflectionPowerRatio({ ...wall, material: 2 }, '2.4ghz', 1);
		const high = reflectionPowerRatio({ ...wall, material: 2 }, '6ghz', 1);
		expect(low).toBeGreaterThan(high);
	});
});

describe('bestReflection', () => {
	it('picks the wall with the strongest return', () => {
		const from = { x: 0, y: 100 };
		const to = { x: 60, y: 100 };
		// 同一面墙分别使用混凝土和玻璃：混凝土反射更强。
		const concrete = bestReflection(from, to, [wall], '5ghz')!;
		const glass = bestReflection(from, to, [{ ...wall, material: 2 }], '5ghz')!;
		expect(concrete).not.toBeNull();
		expect(glass).not.toBeNull();
		expect(concrete.powerRatio).toBeGreaterThan(glass.powerRatio);
	});

	it('honours the distance cull the caller passes', () => {
		const far = { ax: 5000, ay: 0, bx: 5000, by: 200, material: 4 };
		// 典型比例下约 24 m，5 km 外的墙超出距离裁剪。
		expect(bestReflection({ x: 0, y: 100 }, { x: 60, y: 100 }, [far], '5ghz', 24)).toBeNull();
		// 不传距离裁剪时几何有效：墙位于两点后方，这是真实反射（从后方到达），不是错误。
		expect(bestReflection({ x: 0, y: 100 }, { x: 60, y: 100 }, [far], '5ghz')).not.toBeNull();
	});

	it('finds nothing when there are no walls', () => {
		expect(bestReflection({ x: 0, y: 100 }, { x: 60, y: 100 }, [], '5ghz')).toBeNull();
	});

	/**
	 * 校验画面是所有反射之和，而不是只挑最强的一道。
	 * 只取最强会在房间内产生换墙的折痕和缺口，因此模块返回全部反射，由调用方求和。
	 */
	it('returns every wall that reflects, strongest first', () => {
		const from = { x: 0, y: 100 };
		const to = { x: 60, y: 100 };
		// 同一侧的两道墙，都各自有有效的镜面反射点。
		const all = reflections(from, to, [wall, { ...wall, ax: 100, ay: 300, bx: 100, by: 600 }], '5ghz');
		expect(all.length).toBe(1); // 第二道墙在这些端点之间没有反射点
		expect(all[0]!.powerRatio).toBeGreaterThan(0);

		const pair = reflections(
			from,
			to,
			[wall, { ...wall, material: 2 }],
			'5ghz'
		);
		expect(pair.length).toBe(2);
		expect(pair[0]!.powerRatio).toBeGreaterThanOrEqual(pair[1]!.powerRatio);
	});
});
