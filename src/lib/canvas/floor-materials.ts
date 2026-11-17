/**
 * 楼层/天花板材质定义，按频段给出射频衰减。
 * 来源：ITU-R P.1238-10 (2019) 室内传播模型、COST 231 Multi-Wall Multi-Floor Model、
 * iBwave 材质库：https://blog.ibwave.com/a-closer-look-at-attenuation-across-materials-the-2-4ghz-5ghz-bands/
 */

import type { Band } from '@aetherax/channels';

export interface FloorMaterial {
	id: number;
	name: string;
	dbPerMeter: Record<Band, number>; // 每米材质厚度的衰减，单位 dB
	typicalThickness: number; // 默认板厚，单位米
}

export type FloorMaterialId = 0 | 1 | 2 | 3;

/**
 * 楼层材质定义，按每米衰减计算。
 * 总损耗 = dbPerMeter * thickness。
 * 来源：ITU-R P.1238、iBwave 材质库、NIST 测量。
 */
export const FLOOR_MATERIALS: readonly FloorMaterial[] = [
	{
		id: 0,
		name: 'Wood Frame',
		dbPerMeter: { '2.4ghz': 40, '5ghz': 60, '6ghz': 75 },
		typicalThickness: 0.2 // 约 8 英寸搁栅加底板
	},
	{
		id: 1,
		name: 'Concrete Slab',
		dbPerMeter: { '2.4ghz': 75, '5ghz': 100, '6ghz': 120 },
		typicalThickness: 0.2 // 约 8 英寸楼板
	},
	{
		id: 2,
		name: 'Reinforced Concrete',
		dbPerMeter: { '2.4ghz': 100, '5ghz': 140, '6ghz': 160 },
		typicalThickness: 0.2
	},
	{
		id: 3,
		name: 'Steel Deck',
		dbPerMeter: { '2.4ghz': 125, '5ghz': 175, '6ghz': 200 },
		typicalThickness: 0.2
	}
];

/**
 * 返回指定材质、频段和厚度下的楼层衰减，单位 dB。
 * 厚度为 0 或未提供时使用该材质的典型厚度。
 */
export function getFloorAttenuation(
	materialId: FloorMaterialId,
	band: Band,
	thickness?: number
): number {
	const mat = FLOOR_MATERIALS[materialId];
	if (!mat) return 20;
	const t = thickness && thickness > 0 ? thickness : mat.typicalThickness;
	return mat.dbPerMeter[band] * t;
}
