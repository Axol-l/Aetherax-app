/**
 * 单次镜面反射，按功率项计入传播模型：镜像法求反射点，系数取自 `rf/material-itu.ts` 的 P.2040 平板模型。
 * 只处理单次反射，不做多次反射与衍射。
 */
import type { Band } from '@aetherax/channels';
import { getMaterial, type WallMaterialId } from '$lib/domain/materials.js';
import {
	BAND_FREQUENCY_GHZ,
	ituEpsilon,
	slabTransmission
} from './material-itu.js';

export interface ReflectingWall {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: number;
}

export interface Reflection {
	/** 射线与墙面的交点，单位是世界坐标单位。 */
	x: number;
	y: number;
	/** 路径总长：接入点 → 墙面 → 目标点。 */
	length: number;
	/** 墙面处入射角的余弦（1 表示正对墙面）。 */
	cosTheta: number;
	/** 反射功率占入射功率的比例，不超过 1。 */
	powerRatio: number;
}

/**
 * `from` 经 `wall` 镜面反射后到达 `to` 的路径；不存在时返回 null。
 */
export function specularReflection(
	from: { x: number; y: number },
	to: { x: number; y: number },
	wall: ReflectingWall
): { x: number; y: number; length: number; cosTheta: number } | null {
	const dx = wall.bx - wall.ax;
	const dy = wall.by - wall.ay;
	const lenSq = dx * dx + dy * dy;
	if (lenSq < 1e-9) return null;

	const len = Math.sqrt(lenSq);
	const nx = -dy / len;
	const ny = dx / len;
	const sideFrom = (from.x - wall.ax) * nx + (from.y - wall.ay) * ny;
	const sideTo = (to.x - wall.ax) * nx + (to.y - wall.ay) * ny;
	/* 两端必须位于墙面直线的同一侧。 */
	if (sideFrom * sideTo <= 0) return null;

	// f' = f − 2·(f·n̂)n̂
	const imageX = from.x - 2 * sideFrom * nx;
	const imageY = from.y - 2 * sideFrom * ny;

	// 求镜像点→目标点连线与墙面直线的交点。
	const ix = to.x - imageX;
	const iy = to.y - imageY;
	const denom = ix * dy - iy * dx;
	let hitX: number;
	let hitY: number;
	if (Math.abs(denom) < 1e-9) {
		/* 正对情形：镜像点、目标点与墙面共线，交点不唯一，取源点到墙面的垂足。 */
		if (Math.abs(ix) > 1e-9 || Math.abs(iy) > 1e-9) return null;
		hitX = from.x - sideFrom * nx;
		hitY = from.y - sideFrom * ny;
	} else {
		const t = ((wall.ax - imageX) * dy - (wall.ay - imageY) * dx) / denom;
		if (t <= 0 || t >= 1) return null;
		hitX = imageX + ix * t;
		hitY = imageY + iy * t;
	}

	// 交点须落在墙段上，不能落在线段延长线上。
	const along = ((hitX - wall.ax) * dx + (hitY - wall.ay) * dy) / lenSq;
	if (along < 0 || along > 1) return null;

	const d1 = Math.hypot(hitX - from.x, hitY - from.y);
	const d2 = Math.hypot(to.x - hitX, to.y - hitY);
	if (d1 < 1e-9) return null;
	const incident = Math.abs(((hitX - from.x) * nx + (hitY - from.y) * ny) / d1);
	return {
		x: hitX,
		y: hitY,
		length: d1 + d2,
		cosTheta: Math.min(1, Math.max(0, incident))
	};
}

/**
 * 由材质系数算出的反射功率占入射功率的比例。
 */
const coefficientCache = new Map<string, number>();
export function reflectionPowerRatio(
	wall: ReflectingWall,
	band: Band,
	cosTheta: number
): number {
	const material = getMaterial(wall.material as WallMaterialId);
	if (!material.itu) return 0;
	const bucket = Math.round(Math.min(1, Math.max(0, cosTheta)) * 40);
	const key = `${wall.material}:${band}:${bucket}`;
	const cached = coefficientCache.get(key);
	if (cached !== undefined) return cached;

	const frequencyGhz = BAND_FREQUENCY_GHZ[band];
	const { epsR, sigma } = ituEpsilon(material.itu, frequencyGhz);
	const { rTe, rTm } = slabTransmission(
		epsR,
		sigma,
		frequencyGhz,
		material.typicalThickness,
		cosTheta
	);
	const power = (rTe.re * rTe.re + rTe.im * rTe.im + rTm.re * rTm.re + rTm.im * rTm.im) / 2;
	const result = Math.min(1, Math.max(0, power));
	coefficientCache.set(key, result);
	return result;
}

/**
 * 到达 `to` 的全部反射，按强度降序排列，只保留 `minRatio` 以上的项。
 */
export function reflections(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly ReflectingWall[],
	band: Band,
	maxDistance = Infinity,
	minRatio = 1e-4
): Reflection[] {
	const out: Reflection[] = [];
	const midX = (from.x + to.x) / 2;
	const midY = (from.y + to.y) / 2;

	for (const wall of walls) {
		// 按墙中心到路径中点的距离剔除过远的墙。
		const reach = Math.hypot((wall.ax + wall.bx) / 2 - midX, (wall.ay + wall.by) / 2 - midY);
		if (reach > maxDistance) continue;

		const hit = specularReflection(from, to, wall);
		if (!hit) continue;
		const ratio = reflectionPowerRatio(wall, band, hit.cosTheta);
		if (ratio <= minRatio) continue;
		out.push({ ...hit, powerRatio: ratio });
	}
	out.sort((a, b) => b.powerRatio - a.powerRatio);
	return out;
}

/**
 * 从接入点到达 `to` 的最强单次反射；没有时返回 null。
 */
export function bestReflection(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly ReflectingWall[],
	band: Band,
	maxDistance = Infinity
): Reflection | null {
	const all = reflections(from, to, walls, band, maxDistance);
	return all.length > 0 ? all[0]! : null;
}
