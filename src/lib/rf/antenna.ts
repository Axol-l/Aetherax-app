/**
 * 天线的垂直切面：接入点在决定客户端高低方向的平面内的辐射方向图。
 */

/**
 * 单个接入点的垂直方向图。
 *
 * `floorDb` 为侧射方向（偏离峰值 90° 及更远）低于峰值的量，由频段决定且不可编辑；可编辑的是波束宽度与瞄准方向。
 */
export interface AntennaProfile {
	/** 垂直切面的 −3 dB 波束宽度，单位度。 */
	beamwidthDeg: number;
	/**
	 * 方向图峰值的指向，以水平面为基准，单位度。
	 *
	 * 正值为向下，负值为向上，0 为水平且为默认值；该值不根据安装高度推导。
	 */
	aimDeg: number;
	/** 侧射方向（偏离峰值 90° 及更远）低于峰值的量，单位 dB。 */
	floorDb: number;
	/**
	 * 水平切面，仅向前辐射的设备具有。
	 */
	facingDeg?: number;
	/** 水平切面的 −3 dB 宽度，单位度。缺省或 180 表示无水平切面。 */
	azBeamwidthDeg?: number;
	/** 正后方相对正前方的衰减量，单位 dB。 */
	frontToBackDb?: number;
}

/** 各频段的默认波束宽度与侧射电平。 */
const BAND_DEFAULTS: Record<string, { beamwidthDeg: number; floorDb: number }> = {
	'2.4ghz': { beamwidthDeg: 120, floorDb: 7 },
	'5ghz': { beamwidthDeg: 60, floorDb: 12 },
	'6ghz': { beamwidthDeg: 60, floorDb: 13 }
};

/** 最大波束宽度；180° 时方向图平坦。 */
export const MAX_BEAMWIDTH_DEG = 180;
/** 峰值相对水平面的最大瞄准角度，90° 为正下方或正上方。 */
export const MAX_AIM_DEG = 90;

/** 该频段上新建接入点使用的垂直方向图。 */
export function defaultAntenna(beamwidthDeg: number | null, band: string): AntennaProfile {
	const fallback = BAND_DEFAULTS[band] ?? BAND_DEFAULTS['5ghz']!;
	return {
		beamwidthDeg: beamwidthDeg ?? fallback.beamwidthDeg,
		aimDeg: 0,
		floorDb: fallback.floorDb
	};
}

/**
 * 根据接入点或 worker 负载携带的字段构造方向图。
 */
export function antennaProfileForMount(input: {
	band: string;
	beamwidthDeg?: number | null;
	aimDeg?: number | null;
	mount?: string | null;
	facingDeg?: number | null;
}): AntennaProfile {
	const base = defaultAntenna(input.beamwidthDeg ?? null, input.band);
	const profile: AntennaProfile = {
		beamwidthDeg: input.beamwidthDeg ?? base.beamwidthDeg,
		aimDeg: input.aimDeg ?? 0,
		floorDb: base.floorDb
	};
	if (input.mount !== 'wall') return profile;
	return {
		...profile,
		facingDeg: input.facingDeg ?? 0,
		...WALL_MOUNT_AZIMUTH
	};
}

/** 该频段的侧射电平，用于用户改过波束宽度的方向图。 */
export function antennaFloorDb(band: string): number {
	return (BAND_DEFAULTS[band] ?? BAND_DEFAULTS['5ghz']!).floorDb;
}

/**
 * 垂直切面的增益，单位 dB，相对峰值。
 *
 * `angleBelowHorizonDeg` 有符号，向下为正；偏移量为 `|angle − aim|`，超过 90° 后保持侧射电平。
 */
export function elevationGainDb(angleBelowHorizonDeg: number, profile: AntennaProfile): number {
	/* 180° 波束宽度表示“没有垂直方向图”，返回 0；该值无法由下方曲线得到。 */
	if (profile.beamwidthDeg >= MAX_BEAMWIDTH_DEG) return 0;
	// 0 会让半功率角落在峰值处，等于没有波束。
	const half = Math.max(1, profile.beamwidthDeg / 2);
	const offset = Math.abs(angleBelowHorizonDeg - profile.aimDeg);
	if (offset <= half) return -3 * (offset / half) ** 2;
	if (offset >= 90) return -profile.floorDb;
	const t = (offset - half) / (90 - half);
	return -3 - (profile.floorDb - 3) * t * t * (3 - 2 * t);
}

/**
 * 从接入点到目标点的射线相对水平面的夹角，单位度，由射线的垂直与水平分量求得。
 *
 * 向下为正，目标在接入点上方时为负。
 */
export function angleBelowHorizonDeg(vertical: number, horizontal: number): number {
	return (Math.atan2(vertical, horizontal) * 180) / Math.PI;
}

/**
 * 单条射线的垂直切面损耗，单位 dB，为正值，可直接加到该路径的其他损耗上。
 *
 * `elevationGainDb` 返回相对峰值的增益，直接相减会放大信号，本函数统一取反以避免符号错误。
 */
export function antennaLossDb(
	profile: AntennaProfile,
	vertical: number,
	horizontal: number
): number {
	return -elevationGainDb(angleBelowHorizonDeg(vertical, horizontal), profile);
}

/** 壁挂接入点假定的水平切面参数；垂直切面仍使用频段默认值。 */
export const WALL_MOUNT_AZIMUTH: { azBeamwidthDeg: number; frontToBackDb: number } = {
	azBeamwidthDeg: 90,
	frontToBackDb: 20
};

/** 将角度折算到 (−180, 180]。 */
export function wrap180(deg: number): number {
	let a = deg % 360;
	if (a > 180) a -= 360;
	if (a <= -180) a += 360;
	return a;
}

/**
 * 将朝向折算到 [0, 360)，即方向的存储、显示与输出形式。
 *
 * 方向图本身不要求该范围，但字段、JSON 导出与存储值需要统一。
 */
export function normaliseBearing(deg: number): number {
	const a = deg % 360;
	return a < 0 ? a + 360 : a;
}

/** 射线的平面方位角，单位度，从 +x 转向 +y，即 `atan2` 的角度。 */
export function bearingDeg(dx: number, dy: number): number {
	return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * 水平切面的增益，单位 dB，相对自身峰值。
 *
 * 偏移量取自相对 `facingDeg` 的方位角，远端锚点为 180°（正后方）；无水平切面的方向图返回 0。
 */
export function azimuthGainDb(bearing: number, profile: AntennaProfile): number {
	const beamwidth = profile.azBeamwidthDeg;
	if (beamwidth === undefined || beamwidth >= MAX_BEAMWIDTH_DEG) return 0;
	const half = Math.max(1, beamwidth / 2);
	const back = Math.max(3, profile.frontToBackDb ?? 20);
	const offset = Math.abs(wrap180(bearing - (profile.facingDeg ?? 0)));
	if (offset <= half) return -3 * (offset / half) ** 2;
	if (offset >= 180) return -back;
	const t = (offset - half) / (180 - half);
	return -3 - (back - 3) * t * t * (3 - 2 * t);
}

/** 单条射线的水平切面损耗，单位 dB，为正值，约定与 `antennaLossDb` 相同。 */
export function azimuthLossDb(bearing: number, profile: AntennaProfile): number {
	const gain = azimuthGainDb(bearing, profile);
	// 用 `=== 0` 而非直接取负，避免在无水平切面时返回 −0。
	return gain === 0 ? 0 : -gain;
}

/**
 * 单条射线的两个切面损耗之和，即路径损耗中天线部分的单一数值。
 *
 * 垂直与水平损耗在此一并相加，调用方无法只应用其中一项。
 */
export function antennaRayLossDb(
	profile: AntennaProfile,
	vertical: number,
	dx: number,
	dy: number
): number {
	return (
		antennaLossDb(profile, vertical, Math.hypot(dx, dy)) +
		azimuthLossDb(bearingDeg(dx, dy), profile)
	);
}

/**
 * 接入点方向图相关字段的短标识，用作缓存键的一部分。
 *
 * 所有涉及天线的缓存键都通过本函数生成，避免遗漏字段而返回为其他天线生成的图像。
 */
export function antennaSignature(ap: {
	beamwidthDeg?: number | null;
	aimDeg?: number | null;
	mount?: string | null;
	facingDeg?: number | null;
}): string {
	return `${ap.beamwidthDeg ?? 0}/${ap.aimDeg ?? 0}/${ap.mount ?? ''}/${ap.facingDeg ?? 0}`;
}
