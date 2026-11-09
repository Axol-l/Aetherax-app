/**
 * 单次漫散射。
 *
 * 采用 Sionna RT 的 Lambertian 模式：归一化散射方向图为
 *
 *   f_s(θ_s) = cos θ_s / π
 *
 * 墙面把入射功率的一部分按该方向图散开，其余进入镜面反射/透射。这里用镜面反射点
 * 作为整面墙的代表点；不是对墙面做数值积分，属于实时热力图的近似。
 */
import { getScatteringCoefficient, type WallMaterialId } from '$lib/domain/materials.js';import { relativePathLossDb } from './propagation.js';
import type { ReflectingWall } from './reflection.js';

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
 * 一次漫散射的相对功率因子 `S · cos θ_i · cos θ_s / π`；为 0 时没有散射。
 */
export function scatteringFactor(input: {
	wall: ReflectingWall;
	ap: { x: number; y: number };
	hit: { x: number; y: number };
	target: { x: number; y: number };
	material: number;
}): number {
	const coefficient = getScatteringCoefficient(input.material as WallMaterialId);
	if (coefficient <= 0) return 0;
	const cosIn = cosToWall(input.wall, input.ap, input.hit);
	const cosOut = cosToWall(input.wall, input.hit, input.target);
	if (cosIn <= 0 || cosOut <= 0) return 0;
	return coefficient * cosIn * (cosOut / Math.PI);
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
}): number {
	const scattered = scatteringFactor(input);
	if (!(scattered > 0)) return -Infinity;
	return (
		input.apRefDb -
		relativePathLossDb(input.pathLengthM) -
		input.antennaLossDb -
		input.wallLossDb +
		10 * Math.log10(scattered)
	);
}
