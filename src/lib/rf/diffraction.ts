/**
 * 墙面端点处的衍射，按 ITU-R P.526 单刃峰模型计算：端点当作刃峰，由侵入深度求
 * 菲涅耳参数 ν 再取衰减；不处理楔角、反射场过渡与极化。
 */
import type { ReflectingWall } from './reflection.js';

/** 墙体端点，附带所属墙体的材质编号。 */
export interface DiffractionEdge {
	x: number;
	y: number;
	/** 所属墙体的材质编号。 */
	material: number;
}

/** 所有线段的全部端点，每面墙两个。 */
export function edgesOf(walls: readonly ReflectingWall[]): DiffractionEdge[] {
	const edges: DiffractionEdge[] = [];
	for (const wall of walls) {
		edges.push({ x: wall.ax, y: wall.ay, material: wall.material });
		edges.push({ x: wall.bx, y: wall.by, material: wall.material });
	}
	return edges;
}

/**
 * 刃峰损耗，dB；`clearance` 为边缘相对直连路径的净空，单位米，正值表示侵入路径。公式取自 ITU-R P.526 §4.1：
 *
 *   ν = h·√( 2(d₁+d₂) / (λ·d₁·d₂) )
 *   L = 6.9 + 20·log₁₀( √((ν−0.1)²+1) + ν − 0.1 )
 *
 * ν ≤ −0.8、路径长度或波长非正时返回 0。
 */
export function knifeEdgeLossDb(clearance: number, d1: number, d2: number, wavelength: number): number {
	if (!(d1 > 0) || !(d2 > 0) || !(wavelength > 0)) return 0;
	const v = clearance * Math.sqrt((2 * (d1 + d2)) / (wavelength * d1 * d2));
	if (v <= -0.8) return 0;
	return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/**
 * `from` 到 `to` 绕经 `edges` 中某条边缘的最佳衍射损耗；无可用边缘时返回 null。
 *
 * 只考虑位于两端之间、且偏离直连线的边缘。
 */
export function bestDiffraction(
	from: { x: number; y: number },
	to: { x: number; y: number },
	edges: readonly DiffractionEdge[],
	wavelength: number,
	maxClearance = 40,
	maxDistance = 60,
	metersPerWorldUnit = 1
): { lossDb: number; x: number; y: number } | null {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const direct = Math.hypot(dx, dy);
	if (direct < 1e-6) return null;
	const ux = dx / direct;
	const uy = dy / direct;

	let best: { lossDb: number; x: number; y: number } | null = null;
	for (const edge of edges) {
		const ex = edge.x - from.x;
		const ey = edge.y - from.y;
		// 沿路径投影：边缘须位于两端之间。
		const along = ex * ux + ey * uy;
		if (along <= 0 || along >= direct) continue;
		const d1 = Math.hypot(ex, ey);
		const d2 = Math.hypot(to.x - edge.x, to.y - edge.y);
		// The limits and the knife-edge formula are in metres; the geometry here is in
		// world units. One conversion point keeps callers from having to scale their masks.
		const d1M = d1 * metersPerWorldUnit;
		const d2M = d2 * metersPerWorldUnit;
		if (d1M > maxDistance || d2M > maxDistance) continue;
		// 垂直偏移量，符号按接收点所在侧取正，即侵入路径为正。
		const side = ex * uy - ey * ux;
		const clearance = side;
		if (Math.abs(clearance) * metersPerWorldUnit > maxClearance) continue;
		const lossDb = knifeEdgeLossDb(Math.abs(clearance) * metersPerWorldUnit, d1M, d2M, wavelength);
		if (best === null || lossDb < best.lossDb) best = { lossDb, x: edge.x, y: edge.y };
	}
	return best;
}

/** 自由空间波长，单位米。 */
export function wavelengthM(frequencyGhz: number): number {
	return 299_792_458 / (frequencyGhz * 1e9);
}

/** 频段中心频率对应的波长，单位米。 */
export function bandWavelengthM(band: '2.4ghz' | '5ghz' | '6ghz'): number {
	const ghz = { '2.4ghz': 2.447, '5ghz': 5.5, '6ghz': 6.53 } as const;
	return wavelengthM(ghz[band]);
}

/**
 * 被遮挡路径绕过最近边缘后所得的损耗，dB；无可用边缘时返回 0。
 *
 * 仅在直连路径被遮挡时调用；只取距直连线最近的一条边缘。
 */
export function diffractionLossDb(
	from: { x: number; y: number },
	to: { x: number; y: number },
	edges: readonly DiffractionEdge[],
	band: '2.4ghz' | '5ghz' | '6ghz',
	maxClearance = 40,
	maxDistance = 60,
	metersPerWorldUnit = 1
): number {
	const best = bestDiffraction(
		from,
		to,
		edges,
		bandWavelengthM(band),
		maxClearance,
		maxDistance,
		metersPerWorldUnit
	);
	return best?.lossDb ?? 0;
}
