/**
 * 单次漫散射。
 *
 * 采用 Sionna RT 的 Directive 模式（Remcom 办公室示例也用这一模式）：
 * 散射能量集中在镜面反射方向，而不是像 Lambertian 那样围绕法线。
 *
 * 热力图把每面墙切成约 1 m 的面元，逐个面元按面积累加；这是实时的二维墙面积分，
 * 不是完整 3D Monte Carlo 积分。
 */
import { getScatteringCoefficient, type WallMaterialId } from '$lib/domain/materials.js';
import type { Band } from '@aetherax/channels';
import { relativePathLossDb } from './propagation.js';
import type { ReflectingWall } from './reflection.js';

/** Remcom 示例使用的 directive 前向波束参数。 */
export const SCATTERING_ALPHA = 4;

/** 二项式系数，只用于很小的 alpha。 */
function binomial(n: number, k: number): number {
	if (k < 0 || k > n) return 0;
	let result = 1;
	for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
	return result;
}

/**
 * Sionna `DirectivePattern` 的归一化因子，alpha_i = 1、lambda = 1。
 *
 * 归一化是对上半球积分；参数只依赖入射角余弦和 alpha。
 */
export function directiveNormalization(cosThetaI: number, alpha = SCATTERING_ALPHA): number {
	const cosI = Math.min(1, Math.max(0, cosThetaI));
	const sinI = Math.sqrt(Math.max(0, 1 - cosI * cosI));
	let fAlphaR = 0;
	let kNone = 0;
	for (let j = 0; j <= alpha; j++) {
		let iJ: number;
		if (j % 2 === 0) {
			iJ = (2 * Math.PI) / (j + 1);
		} else {
			const n = (j - 1) / 2;
			const v = (Math.pow(sinI, 2 * n) * binomial(2 * n, n)) / Math.pow(2, 2 * n);
			kNone += v;
			iJ = (cosI * kNone * 2 * Math.PI) / (j + 1);
		}
		fAlphaR += iJ * binomial(alpha, j);
	}
	return fAlphaR / Math.pow(2, alpha);
}

/** 墙面的单位法线；方向取墙的任一侧，调用方用绝对值。 */
export function wallNormal(wall: Pick<ReflectingWall, 'ax' | 'ay' | 'bx' | 'by'>): {
	x: number;
	y: number;
} {
	const dx = wall.bx - wall.ax;
	const dy = wall.by - wall.ay;
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) return { x: 0, y: 0 };
	return { x: -dy / len, y: dx / len };
}

/** 点到墙面的入射/出射角余弦绝对值，0 表示平行掠射。 */
function cosToWall(
	wall: ReflectingWall,
	from: { x: number; y: number },
	to: { x: number; y: number }
): number {
	const normal = wallNormal(wall);
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) return 0;
	return Math.abs((dx * normal.x + dy * normal.y) / len);
}

/**
 * Directive 方向图，围绕镜面反射方向归一化。
 */
export function directivePatternFactor(input: {
	wall: ReflectingWall;
	ap: { x: number; y: number };
	hit: { x: number; y: number };
	target: { x: number; y: number };
	alpha?: number;
	/** 预计算的归一化因子；不传时按入射角现算。 */
	normalization?: number;
}): number {
	const alpha = input.alpha ?? SCATTERING_ALPHA;
	const normal = wallNormal(input.wall);
	const inX = input.hit.x - input.ap.x;
	const inY = input.hit.y - input.ap.y;
	const inLen = Math.hypot(inX, inY);
	const outX = input.target.x - input.hit.x;
	const outY = input.target.y - input.hit.y;
	const outLen = Math.hypot(outX, outY);
	if (inLen < 1e-9 || outLen < 1e-9) return 0;

	const kiX = inX / inLen;
	const kiY = inY / inLen;
	const dotI = kiX * normal.x + kiY * normal.y;
	const cosI = Math.abs(dotI);
	if (cosI <= 0) return 0;

	// 镜面反射方向：ki − 2(ki·n)n。
	const ksX = kiX - 2 * dotI * normal.x;
	const ksY = kiY - 2 * dotI * normal.y;
	const koX = outX / outLen;
	const koY = outY / outLen;
	const cosPsi = Math.min(1, Math.max(-1, ksX * koX + ksY * koY));
	const raw = Math.pow(0.5 * (1 + cosPsi), alpha);
	const norm =
		input.normalization ?? directiveNormalization(cosI, alpha);
	return norm > 0 ? raw / norm : 0;
}

/**
 * 一次漫散射的相对功率因子 `S · cos θ_i · f_s`；为 0 时没有散射。
 */
export function scatteringFactor(input: {
	wall: ReflectingWall;
	ap: { x: number; y: number };
	hit: { x: number; y: number };
	target: { x: number; y: number };
	material: number;
	band: Band;
	alpha?: number;
	normalization?: number;
}): number {
	const coefficient = getScatteringCoefficient(input.material as WallMaterialId, input.band);
	if (coefficient <= 0) return 0;
	const cosIn = cosToWall(input.wall, input.ap, input.hit);
	if (cosIn <= 0) return 0;
	const pattern = directivePatternFactor(input);
	if (!(pattern > 0)) return 0;
	return coefficient * cosIn * pattern;
}

/**
 * 从 AP 经墙面上一次漫散射后到达客户端的接收电平，dBm。
 *
 * 与镜面反射使用同一条 AP → 墙 → 客户端的路径长度和墙损；区别是把反射系数换成
 * `S · f_s(θ_s) · cos θ_i`。S 为该材质的散射系数，θ_i 是 AP 到墙的入射角。
 */
export function diffuseLevelDb(input: {
	apRefDb: number;
	pathLengthM: number;
	antennaLossDb: number;
	wallLossDb: number;
	wall: ReflectingWall;
	ap: { x: number; y: number };
	hit: { x: number; y: number };
	target: { x: number; y: number };
	material: number;
	band: Band;
	/** 当前散射面元的等效面积，平方米；远墙近似时用整面墙面积。 */
	areaM2?: number;
	/** 预计算的 Directive 归一化因子。 */
	normalization?: number;
}): number {
	const scattered = scatteringFactor(input) * (input.areaM2 ?? 1);
	if (!(scattered > 0)) return -Infinity;
	return (
		input.apRefDb -
		relativePathLossDb(input.pathLengthM) -
		input.antennaLossDb -
		input.wallLossDb +
		10 * Math.log10(scattered)
	);
}
