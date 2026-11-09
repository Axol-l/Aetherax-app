/**
 * 墙体材质定义，以及逐米、逐频段的射频衰减。
 * 有 P.2040 编号的材质按模型计算，其余用表里的 dB/m 乘厚度。
 */

import type { Band } from '@aetherax/channels';
import { BAND_FREQUENCY_GHZ, ituWallLossDb, type ItuMaterialKey } from '../rf/material-itu.js';

export type WallMaterialId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WallMaterial {
	id: WallMaterialId;
	name: string;
	/**
	 * 该材质对应的 P.2040 材质编号。
	 * 有编号时损耗按模型计算；没有时回退到 `dbPerMeter`。
	 */
	itu?: ItuMaterialKey;
	/** 回退用的每米损耗，单位 dB/m，按频段给出。 */
	dbPerMeter: Record<Band, number>;
	typicalThickness: number; // 典型厚度，单位米，未标定时使用。
	/** 单次漫散射系数，0 表示只有镜面反射。未填写时用内置默认值。 */
	scatteringCoefficient?: number;
	/** 漫散射中转为交叉极化的功率比例，0..0.5。 */
	crossPolarizationRatio?: number;
	color: [number, number, number];
}

/**
 * 内置材质表：每米、每频段的衰减，单位 dB/m。
 * 单次穿越损耗 = `dbPerMeter[band]` × 厚度；未标定时用 `typicalThickness`。
 */
export const WALL_MATERIALS: readonly WallMaterial[] = [
	{
		id: 0,
		name: 'Drywall',
		// P.2040 对应石膏板，按 12 mm 隔墙计。
		itu: 'plasterboard',
		dbPerMeter: { '2.4ghz': 13, '5ghz': 25, '6ghz': 30 },
		typicalThickness: 0.12,
		// Remcom 5G mmWave office example: 3-layer drywall = 0.2.
		scatteringCoefficient: 0.2,
		color: [200, 200, 210]
	},
	{
		id: 1,
		name: 'Wood',
		itu: 'wood',
		dbPerMeter: { '2.4ghz': 17, '5ghz': 33, '6ghz': 40 },
		typicalThickness: 0.15,
		// No measured value in the cited example; use the conservative indoor default.
		scatteringCoefficient: 0.2,
		color: [160, 130, 90]
	},
	{
		id: 2,
		name: 'Glass',
		itu: 'glass',
		dbPerMeter: { '2.4ghz': 105, '5ghz': 200, '6ghz': 240 },
		typicalThickness: 0.01,
		scatteringCoefficient: 0.1,
		color: [140, 210, 230]
	},
	{
		id: 3,
		name: 'Brick',
		itu: 'brick',
		dbPerMeter: { '2.4ghz': 18, '5ghz': 35, '6ghz': 42 },
		typicalThickness: 0.23,
		scatteringCoefficient: 0.3,
		color: [180, 80, 60]
	},
	{
		id: 4,
		name: 'Concrete',
		itu: 'concrete',
		dbPerMeter: { '2.4ghz': 32, '5ghz': 60, '6ghz': 72 },
		typicalThickness: 0.2,
		// Remcom 5G mmWave office example: concrete = 0.4.
		scatteringCoefficient: 0.4,
		color: [130, 130, 140]
	},
	{
		id: 5,
		name: 'Metal',
		itu: 'metal',
		dbPerMeter: { '2.4ghz': 63, '5ghz': 120, '6ghz': 144 },
		typicalThickness: 0.17,
		// Remcom example: metal cabinets/desk supports = 0.2.
		scatteringCoefficient: 0.2,
		color: [90, 100, 120]
	},
	{
		/**
		 * 零衰减隔断。
		 * 它在墙体掩码里，房间与密度区域会在它处断开；穿过它的射频路径不扣损耗。
		 */
		id: 6,
		name: 'Virtual Partition',
		dbPerMeter: { '2.4ghz': 0, '5ghz': 0, '6ghz': 0 },
		typicalThickness: 0.12,
		color: [120, 200, 180]
	},
	{
		/**
		 * 关闭的木门。
		 * 单次穿越损耗按工程取值：5 GHz 下 45 mm 门扇约 4.95 dB。
		 */
		id: 7,
		name: 'Door',
		dbPerMeter: { '2.4ghz': 58, '5ghz': 110, '6ghz': 132 },
		typicalThickness: 0.045,
		scatteringCoefficient: 0.2,
		color: [205, 160, 115]
	}
] as const;

export const DEFAULT_MATERIAL: WallMaterialId = 0;

/** 真正有衰减的材质 id，排除零衰减隔断。 */
export const ATTENUATING_MATERIAL_IDS: readonly WallMaterialId[] = WALL_MATERIALS.filter((m) =>
	Object.values(m.dbPerMeter).some((db) => db > 0)
).map((m) => m.id);

/** 是否为零衰减隔断：分隔空间但不吸收信号。 */
export function isVirtualMaterial(id: WallMaterialId): boolean {
	const m = WALL_MATERIALS[id];
	return m != null && Object.values(m.dbPerMeter).every((db) => db === 0);
}

/**
 * 频段预设的单次漫散射系数。
 *
 * 这些不是通用材料常数：Remcom 的测量示例针对 60 GHz；2.4/5/6 GHz 的值是按频段
 * 下调后的工程预设。没有实测数据的材质只用于给出数量级，不能当作验收依据。
 */
const SCATTERING_BY_BAND: Record<Band, Record<number, number>> = {
	'2.4ghz': { 0: 0.05, 1: 0.05, 2: 0.02, 3: 0.08, 4: 0.15, 5: 0.1, 6: 0, 7: 0.05 },
	'5ghz': { 0: 0.1, 1: 0.1, 2: 0.03, 3: 0.12, 4: 0.25, 5: 0.15, 6: 0, 7: 0.1 },
	'6ghz': { 0: 0.12, 1: 0.12, 2: 0.04, 3: 0.15, 4: 0.3, 5: 0.18, 6: 0, 7: 0.12 }
};

export const DEFAULT_SCATTERING_COEFFICIENT = 0.15;
/** 漫散射的默认交叉极化功率比例，取自 Remcom 示例的量级。 */
export const DEFAULT_CROSS_POLARIZATION_RATIO = 0.2;

/** 某材质的漫散射交叉极化功率比例，范围 [0, 0.5]。 */
export function getCrossPolarizationRatio(id: WallMaterialId): number {
	const custom = customMaterials.find((material) => material.id === id);
	if (custom?.crossPolarizationRatio !== undefined) {
		return Math.min(0.5, Math.max(0, custom.crossPolarizationRatio));
	}
	return isVirtualMaterial(id) ? 0 : DEFAULT_CROSS_POLARIZATION_RATIO;
}

/** 某材质在某频段的单次漫散射系数，范围 [0, 1]。 */
export function getScatteringCoefficient(
	id: WallMaterialId,
	band: Band = '5ghz'
): number {
	const custom = customMaterials.find((material) => material.id === id);
	// 自定义材质显式给出的 S 视为用户校准值，优先于内置频段预设。
	if (custom?.scatteringCoefficient !== undefined) {
		return Math.min(1, Math.max(0, custom.scatteringCoefficient));
	}
	if (isVirtualMaterial(id)) return 0;
	const preset = SCATTERING_BY_BAND[band]?.[id];
	if (preset !== undefined) return Math.min(1, Math.max(0, preset));
	return Math.min(1, Math.max(0, DEFAULT_SCATTERING_COEFFICIENT));
}

/** 调用方没有 AP 频段信息时使用的默认频段。 */
export const DEFAULT_BAND: Band = '5ghz';

/**
 * 用户自定义材质，由工程在挂载和变更时注册一次。
 * 渲染器、求解器和 Worker 都从这里查表，保证各处看到同一份材质。
 */
let customMaterials: WallMaterial[] = [];

export function registerCustomMaterials(materials: readonly WallMaterial[]): void {
	customMaterials = [...materials];
}

/** 内置材质加上用户自定义材质，所有查表都应使用这张表。 */
export function wallMaterialTable(): WallMaterial[] {
	return customMaterials.length === 0
		? [...(WALL_MATERIALS as readonly WallMaterial[])]
		: [...(WALL_MATERIALS as readonly WallMaterial[]), ...customMaterials];
}

export function getMaterial(id: WallMaterialId): WallMaterial {
	const found = wallMaterialTable().find((material) => material.id === id);
	return found ?? WALL_MATERIALS[0]!;
}

/**
 * 斜入射穿越损耗。P.2040 材质用 Fresnel slab 模型；没有 ITU 参数的材质退回到
 * 正入射的标量损耗。
 *
 * `cosTheta` 是入射角余弦，1 表示正入射。
 */
const angleLossCache = new Map<string, number>();
export function getWallLossDbAtAngle(
	id: WallMaterialId,
	band: Band = DEFAULT_BAND,
	cosTheta = 1
): number {
	const m = wallMaterialTable().find((material) => material.id === id);
	if (!m?.itu) return getFlatAttenuation(id, band);
	const cos = Math.min(1, Math.max(0.05, cosTheta));
	const bucket = Math.round(cos * 40);
	const key = `${id}:${band}:${bucket}`;
	const cached = angleLossCache.get(key);
	if (cached !== undefined) return cached;
	const value = ituWallLossDb(m.itu, BAND_FREQUENCY_GHZ[band], m.typicalThickness, cos);
	angleLossCache.set(key, value);
	return value;
}

/**
 * 该材质在指定频段下一次典型穿越的损耗，单位 dB。
 * 有 P.2040 编号的按模型计算，否则用 `dbPerMeter × typicalThickness`；结果有缓存。
 */
const flatCache = new Map<string, number>();
export function getFlatAttenuation(id: WallMaterialId, band: Band = DEFAULT_BAND): number {
	const m = WALL_MATERIALS[id] ?? customMaterials.find((material) => material.id === id);
	if (!m) return 3;
	const key = `${id}:${band}`;
	const cached = flatCache.get(key);
	if (cached !== undefined) return cached;
	let value: number;
	if (m.itu) {
		value = ituWallLossDb(m.itu, BAND_FREQUENCY_GHZ[band], m.typicalThickness);
	} else {
		value = m.dbPerMeter[band] * m.typicalThickness;
	}
	flatCache.set(key, value);
	return value;
}

/**
 * 按材质 id 索引的单次穿越损耗表，单位 dB。
 * 穿墙步进和热力图场都用它，每个请求的 id 都必须有值。
 */
export function getMaterialDbTable(band: Band = DEFAULT_BAND): number[] {
	const table = wallMaterialTable();
	const out: number[] = [];
	// 按 id 下标存放，自定义材质也能落到掩码像素指向的位置；未知 id 按默认材质计。
	const fallback = getFlatAttenuation(DEFAULT_MATERIAL, band);
	for (const material of table) {
		if (material.id >= 0 && material.id < 256) {
			// 与单次穿越损耗一致：真实材质走 P.2040 模型，自定义材质用每米损耗乘厚度。
			out[material.id] = getFlatAttenuation(material.id, band);
		}
	}
	for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = fallback;
	return out;
}

export function getMaterialByName(name: string): WallMaterial | undefined {
	return WALL_MATERIALS.find((m) => m.name.toLowerCase() === name.toLowerCase());
}
