/**
 * 用户自定义的墙体材质。
 *
 * 内置表覆盖常见情况，但勘测常碰到表里没有的东西：铅衬门、仓库货架、有规格书的玻璃隔断。
 * 存的是“每次穿过的 dB + 厚度”，因为规格书就这么写、用户也能核对；模型按米算损耗，
 * 所以内部按 `dbPerMeter = dbPerCrossing / thickness` 推导，只让人填一组数，省得两个数打架。
 */
import { WALL_MATERIALS, type WallMaterial, type WallMaterialId } from '$lib/domain/materials.js';

export interface CustomMaterial {
	/** 从 100 起编号，避免和内置表撞号。 */
	id: number;
	name: string;
	/** 厚度为 `thicknessM` 时穿过一次的损耗（dB），即规格书上的数字。 */
	dbPerCrossing: number;
	thicknessM: number;
	color: [number, number, number];
}

export const CUSTOM_MATERIAL_ID_BASE = 100;

/** 在已占用的编号里找下一个空号。 */
export function nextCustomMaterialId(existing: readonly CustomMaterial[]): number {
	let id = CUSTOM_MATERIAL_ID_BASE;
	const taken = new Set(existing.map((material) => material.id));
	while (taken.has(id)) id++;
	return id;
}

/**
 * 内置表加上用户的材质，拉平成应用其它部分期望的形状。
 *
 * 只维护一份平铺列表，选择器、色卡和物理表看到的才是同一套；否则就得把“自定义材质”参数
 * 一层层传下去，迟早有一个调用方漏掉。
 */
export function allWallMaterials(custom: readonly CustomMaterial[]): WallMaterial[] {
	const builtIns = WALL_MATERIALS as readonly WallMaterial[];
	if (custom.length === 0) return [...builtIns];
	return [
		...builtIns,
		...custom.map(
			(material): WallMaterial => ({
				id: material.id as WallMaterialId,
				name: material.name,
				dbPerMeter: {
					'2.4ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
					'5ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
					'6ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM)
				},
				typicalThickness: material.thicknessM,
				color: material.color
			})
		)
	];
}

/** 按 id 查材质，先查内置的。 */
export function wallMaterialById(
	id: number,
	custom: readonly CustomMaterial[]
): WallMaterial | null {
	return allWallMaterials(custom).find((material) => material.id === id) ?? null;
}
