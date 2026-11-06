/**
 * 校验垂直天线切片的锚点、单调性及其与厂商实测数据的拟合。
 * 锚点为峰值 0 dB、半功率角 −3 dB 和侧射最低增益；部分测试直接锁定数值而非形状。
 */
import { describe, expect, it } from 'vitest';
import {
	angleBelowHorizonDeg,
	antennaFloorDb,
	antennaLossDb,
	antennaRayLossDb,
	azimuthGainDb,
	azimuthLossDb,
	bearingDeg,
	defaultAntenna,
	elevationGainDb,
	WALL_MOUNT_AZIMUTH,
	wrap180,
	type AntennaProfile
} from './antenna.js';

const omni5 = defaultAntenna(null, '5ghz');
const omni24 = defaultAntenna(null, '2.4ghz');

describe('elevationGainDb', () => {
	it('is 0 dB on the peak and −3 dB at the half-power angle', () => {
		expect(elevationGainDb(0, omni5)).toBeCloseTo(0, 10);
		expect(elevationGainDb(30, omni5)).toBeCloseTo(-3, 10);
		// 2.4 GHz 默认波束宽度是 5 GHz 的两倍，因此 −3 dB 出现在两倍远的角度。
		expect(elevationGainDb(0, omni24)).toBeCloseTo(0, 10);
		expect(elevationGainDb(60, omni24)).toBeCloseTo(-3, 10);
	});

	it('reaches the broadside floor at 90° and stays there', () => {
		expect(elevationGainDb(90, omni5)).toBeCloseTo(-12, 10);
		expect(elevationGainDb(120, omni5)).toBeCloseTo(-12, 10);
		expect(elevationGainDb(-180, omni5)).toBeCloseTo(-12, 10);
	});

	it('never increases with the angle off the peak', () => {
		for (const beamwidth of [30, 60, 90, 120, 179]) {
			const profile: AntennaProfile = { beamwidthDeg: beamwidth, aimDeg: 0, floorDb: 12 };
			let previous = Infinity;
			// 按偏移量扫描而非按角度：方向图关于峰值对称，从 −180° 扫到 180° 会再次走回峰值。
			for (let offset = 0; offset <= 180; offset += 1) {
				const gain = elevationGainDb(offset, profile);
				expect(gain).toBeLessThanOrEqual(previous + 1e-9);
				previous = gain;
			}
		}
	});

	it('is flat at 180°, which is how "no pattern" is expressed', () => {
		const flat: AntennaProfile = { beamwidthDeg: 180, aimDeg: 0, floorDb: 12 };
		for (const angle of [0, 45, 90, 135, 180]) {
			expect(elevationGainDb(angle, flat)).toBeCloseTo(0, 10);
		}
		// 这也复现了本模块之前的模型：水平射线与垂直向下射线得到相同处理。
		expect(elevationGainDb(90, flat)).toBe(elevationGainDb(0, flat));
	});

	it('is symmetric about the horizon without aim, and not with it', () => {
		expect(elevationGainDb(40, omni5)).toBeCloseTo(elevationGainDb(-40, omni5), 10);
		const tilted: AntennaProfile = { ...omni5, aimDeg: 20 };
		// 下倾 20° 后峰值位于水平线下方 20°：向下 20° 的射线在峰值上，向上 20° 的射线偏离
		// 40°，与向下 60° 的射线偏离相同。
		expect(elevationGainDb(20, tilted)).toBeCloseTo(0, 10);
		expect(elevationGainDb(-20, tilted)).toBeLessThan(elevationGainDb(20, tilted));
		expect(elevationGainDb(-20, tilted)).toBeCloseTo(elevationGainDb(60, tilted), 10);
	});

	it('matches the measured vendor cuts within a decibel where a client sits', () => {
		/*
		 * 3 m 层高、默认吊顶预设下，同层客户端在 2 m / 1 m / 0.5 m 处分别低于水平线
		 * 35° / 54° / 70°；默认方向图应落在三款本地模型实测的 5 GHz 衰减区间内。
		 */
		const at = (deg: number) => -elevationGainDb(deg, omni5);
		expect(at(35)).toBeGreaterThan(2);
		expect(at(35)).toBeLessThan(7);
		expect(at(54)).toBeGreaterThan(4);
		expect(at(54)).toBeLessThan(8);
		expect(at(70)).toBeGreaterThan(5);
		expect(at(70)).toBeLessThan(10);
		// 近场必须比远场更差，否则方向图没有起作用：20 m 处仅低于水平线 4°。
		expect(at(4)).toBeLessThan(1);
		expect(at(70)).toBeGreaterThan(at(4) + 4);
	});
});

describe('defaultAntenna', () => {
	it('is a level doughnut with the band’s own width', () => {
		expect(omni5).toEqual({ beamwidthDeg: 60, aimDeg: 0, floorDb: 12 });
		expect(omni24.beamwidthDeg).toBe(120);
		expect(omni24.aimDeg).toBe(0);
	});

	it('falls back to 5 GHz for a band it has no measurement for', () => {
		expect(defaultAntenna(null, 'unknown').beamwidthDeg).toBe(60);
		expect(antennaFloorDb('unknown')).toBe(12);
		expect(antennaFloorDb('2.4ghz')).toBe(7);
	});
});

describe('angleBelowHorizonDeg', () => {
	it('is 0 for a level ray, 90 straight down and negative above', () => {
		expect(angleBelowHorizonDeg(0, 10)).toBeCloseTo(0, 10);
		expect(angleBelowHorizonDeg(1.4, 0)).toBeCloseTo(90, 10);
		expect(angleBelowHorizonDeg(-1.4, 0)).toBeCloseTo(-90, 10);
	});

	it('matches the geometry of a ceiling access point', () => {
		// 低于 AP 1.4 m、水平距离 2 m：35°。
		expect(angleBelowHorizonDeg(1.4, 2)).toBeCloseTo(35, 0);
		// 同样 1.4 m 高度差、客户端距离 20 m 时，射线接近水平。
		expect(angleBelowHorizonDeg(1.4, 20)).toBeCloseTo(4, 0);
	});
});

describe('antennaLossDb', () => {
	/**
	 * 符号检查，使用调用方实际使用的量级：`elevationGainDb` 除峰值外为负，若被相减就会增加信号。
	 * 因此这里只断言损耗恒为非负。
	 */
	it('is a positive loss, never a gain', () => {
		for (const angle of [0, 10, 35, 54, 70, 90, 120]) {
			const vertical = Math.sin((angle * Math.PI) / 180);
			const horizontal = Math.cos((angle * Math.PI) / 180);
			expect(antennaLossDb(omni5, vertical, horizontal)).toBeGreaterThanOrEqual(0);
		}
	});

	it('grows as the ray gets steeper, and as the beam gets narrower', () => {
		// 1.4 m 高度差对应 20 m / 2 m / 0.5 m 水平距离：4° / 35° / 70°。
		const shallow = antennaLossDb(omni5, 1.4, 20);
		const middle = antennaLossDb(omni5, 1.4, 2);
		const steep = antennaLossDb(omni5, 1.4, 0.5);
		expect(shallow).toBeLessThan(middle);
		expect(middle).toBeLessThan(steep);
		// 波束更窄、射线相同：近场损耗严格更大。
		const narrow = antennaLossDb({ ...omni5, beamwidthDeg: 30 }, 1.4, 0.5);
		expect(narrow).toBeGreaterThan(steep);
		// 平坦方向图在任何方向都不产生损耗——即本模块之前的模型。
		expect(antennaLossDb({ ...omni5, beamwidthDeg: 180 }, 1.4, 0.25)).toBeCloseTo(0, 10);
	});
});

describe('the wall mount’s horizontal cut', () => {
	/** 壁挂设备：频段垂直切片加上假定的水平切片。 */
	const wall = (facingDeg: number): AntennaProfile => ({
		...defaultAntenna(null, '5ghz'),
		facingDeg,
		...WALL_MOUNT_AZIMUTH
	});

	it('is absent unless the profile says the hardware has one', () => {
		// 所有吊顶安装，以及壁挂安装出现之前写入的所有 profile。
		for (const bearing of [0, 45, 90, 180, -135]) {
			expect(azimuthGainDb(bearing, omni5)).toBe(0);
			expect(azimuthLossDb(bearing, omni5)).toBe(0);
			// 180° 水平切片是文档中表示“完全没有水平方向性”的方式。
			expect(azimuthGainDb(bearing, { ...omni5, azBeamwidthDeg: 180 })).toBe(0);
		}
	});

	it('is 0 dB straight ahead, −3 dB at the half-power angle and the floor behind', () => {
		const profile = wall(0);
		const half = WALL_MOUNT_AZIMUTH.azBeamwidthDeg / 2;
		expect(azimuthGainDb(0, profile)).toBeCloseTo(0, 10);
		expect(azimuthGainDb(half, profile)).toBeCloseTo(-3, 10);
		expect(azimuthGainDb(-half, profile)).toBeCloseTo(-3, 10);
		expect(azimuthGainDb(180, profile)).toBeCloseTo(-WALL_MOUNT_AZIMUTH.frontToBackDb, 10);
		expect(azimuthGainDb(-180, profile)).toBeCloseTo(-WALL_MOUNT_AZIMUTH.frontToBackDb, 10);
	});

	it('never rises as the bearing turns away from the facing direction', () => {
		const profile = wall(0);
		const samples = [0, 15, 30, 45, 60, 90, 120, 150, 179].map((b) => azimuthGainDb(b, profile));
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
		}
		expect(samples[samples.length - 1]!).toBeLessThan(samples[0]! - 15);
	});

	it('turns with the facing direction', () => {
		const profile = wall(90);
		// 朝向 +y（atan2 的 90°），因此正前方是 90°、正后方是 −90°。
		expect(azimuthGainDb(90, profile)).toBeCloseTo(0, 10);
		expect(azimuthGainDb(-90, profile)).toBeCloseTo(-WALL_MOUNT_AZIMUTH.frontToBackDb, 10);
		// 同一方向用不同角度表示：450° 即 90°。
		expect(azimuthGainDb(450, profile)).toBeCloseTo(0, 10);
	});

	it('leaves the vertical cut alone, and only the azimuth term changes the ray', () => {
		// 相同的三维几何、相反的水平方向：距离和仰角一致，差异完全来自壁挂设备的后瓣。
		const profile = wall(0);
		const front = antennaRayLossDb(profile, 1.4, 2, 0);
		const back = antennaRayLossDb(profile, 1.4, -2, 0);
		expect(front).toBeCloseTo(antennaLossDb(profile, 1.4, 2), 10);
		expect(back - front).toBeCloseTo(WALL_MOUNT_AZIMUTH.frontToBackDb, 6);
		// 吊顶全向天线没有优选方向：两条射线相同。
		expect(antennaRayLossDb(omni5, 1.4, -2, 0)).toBeCloseTo(antennaRayLossDb(omni5, 1.4, 2, 0), 10);
	});
});

describe('wrap180 / bearingDeg', () => {
	it('folds any angle into (−180, 180]', () => {
		expect(wrap180(0)).toBe(0);
		expect(wrap180(350)).toBeCloseTo(-10, 10);
		expect(wrap180(-350)).toBeCloseTo(10, 10);
		expect(wrap180(180)).toBe(180);
		expect(wrap180(540)).toBe(180);
	});

	it('reads the plan bearing of a ray the way atan2 does', () => {
		expect(bearingDeg(1, 0)).toBeCloseTo(0, 10);
		expect(bearingDeg(0, 1)).toBeCloseTo(90, 10);
		expect(bearingDeg(-1, 0)).toBeCloseTo(180, 10);
		expect(bearingDeg(0, -1)).toBeCloseTo(-90, 10);
	});
});
