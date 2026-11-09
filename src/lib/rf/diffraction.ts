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
	/** 以这个端点为端点的墙；可见性检查时排除它们，避免刃峰自身被当成遮挡。 */
	wallIndices?: number[];
	/** 竖直刃边从地面到墙顶的高度，单位世界坐标；0 表示旧版二维端点。 */
	heightWu?: number;
}

/** 所有线段的全部端点，每个不同的端点只出现一次。 */
export function edgesOf(walls: readonly ReflectingWall[], heightWu = 0): DiffractionEdge[] {
	const byPoint = new Map<string, DiffractionEdge>();
	walls.forEach((wall, wallIndex) => {
		for (const point of [
			{ x: wall.ax, y: wall.ay },
			{ x: wall.bx, y: wall.by }
		]) {
			const key = `${point.x},${point.y}`;
			const edge = byPoint.get(key);
			if (edge) {
				edge.wallIndices?.push(wallIndex);
			} else {
				byPoint.set(key, {
					...point,
					material: wall.material,
					wallIndices: [wallIndex],
					heightWu: heightWu > 0 ? heightWu : undefined
				});
			}
		}
	});
	return [...byPoint.values()];
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

export interface DiffractionPath {
	lossDb: number;
	x: number;
	y: number;
	/** 沿竖直刃边的绕射点高度，世界坐标。 */
	z: number;
	/** AP → 绕射点，世界坐标长度。 */
	d1: number;
	/** 绕射点 → 客户端，世界坐标长度。 */
	d2: number;
	edge: DiffractionEdge;
}

/**
 * 竖直刃边上的绕射点：最小化 AP → 刃边点 → 客户端的总路程。
 *
 * 刃边是一段从地面到墙顶的竖直线。两端高度相同时，最短路在客户端高度；
 * 高度不同时用三分搜索在 [0, height] 内求凸函数的最小值。这是三维刃边的
 * 最小路程近似，不建立完整楔形。
 */
function edgePointZ(
	a: number,
	b: number,
	fromZ: number,
	toZ: number,
	height: number
): number {
	if (!(height > 0)) return 0;
	if (a < 1e-9) return Math.min(height, Math.max(0, fromZ));
	if (b < 1e-9) return Math.min(height, Math.max(0, toZ));
	if (Math.abs(fromZ - toZ) < 1e-9) {
		return Math.min(height, Math.max(0, fromZ));
	}
	const distance = (z: number) => Math.hypot(a, z - fromZ) + Math.hypot(b, z - toZ);
	let lo = 0;
	let hi = height;
	for (let i = 0; i < 28; i++) {
		const m1 = lo + (hi - lo) / 3;
		const m2 = hi - (hi - lo) / 3;
		if (distance(m1) <= distance(m2)) hi = m2;
		else lo = m1;
	}
	return (lo + hi) / 2;
}

/**
 * 所有满足几何和可见性条件的刃峰路径，按损耗升序排列。
 *
 * ITU-R P.526 公式是单刃峰的；真实房间可能同时有多个墙端向同一客户端绕射，
 * 调用方应以功率和累加这些路径，而不是只取最强的一条。
 */
export function diffractionPaths(
	from: { x: number; y: number; z?: number },
	to: { x: number; y: number; z?: number },
	edges: readonly DiffractionEdge[],
	wavelength: number,
	maxClearance = 40,
	maxDistance = 60,
	metersPerWorldUnit = 1,
	visible?: (edge: DiffractionEdge) => boolean,
	limit = Infinity
): DiffractionPath[] {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const direct = Math.hypot(dx, dy);
	if (direct < 1e-6) return [];
	const ux = dx / direct;
	const uy = dy / direct;
	const fromZ = from.z ?? 0;
	const toZ = to.z ?? 0;

	const out: DiffractionPath[] = [];
	for (const edge of edges) {
		if (visible && !visible(edge)) continue;
		const ex = edge.x - from.x;
		const ey = edge.y - from.y;
		// 沿路径投影：边缘须位于两端之间。
		const along = ex * ux + ey * uy;
		if (along <= 0 || along >= direct) continue;
		const a = Math.hypot(ex, ey);
		const b = Math.hypot(to.x - edge.x, to.y - edge.y);
		const z = edgePointZ(a, b, fromZ, toZ, edge.heightWu ?? 0);
		const d1 = Math.hypot(a, z - fromZ);
		const d2 = Math.hypot(b, z - toZ);
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
		out.push({ lossDb, x: edge.x, y: edge.y, z, d1, d2, edge });
	}
	out.sort((a, b) => a.lossDb - b.lossDb);
	return Number.isFinite(limit) ? out.slice(0, Math.max(0, limit)) : out;
}

/**
 * `from` 到 `to` 绕经 `edges` 中某条边缘的最佳衍射损耗；无可用边缘时返回 null。
 *
 * 只考虑位于两端之间、且偏离直连线的边缘。
 */
export function bestDiffraction(
	from: { x: number; y: number; z?: number },
	to: { x: number; y: number; z?: number },
	edges: readonly DiffractionEdge[],
	wavelength: number,
	maxClearance = 40,
	maxDistance = 60,
	metersPerWorldUnit = 1,
	visible?: (edge: DiffractionEdge) => boolean
): DiffractionPath | null {
	return (
		diffractionPaths(
			from,
			to,
			edges,
			wavelength,
			maxClearance,
			maxDistance,
			metersPerWorldUnit,
			visible,
			1
		)[0] ?? null
	);
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
	metersPerWorldUnit = 1,
	visible?: (edge: DiffractionEdge) => boolean
): number {
	const best = bestDiffraction(
		from,
		to,
		edges,
		bandWavelengthM(band),
		maxClearance,
		maxDistance,
		metersPerWorldUnit,
		visible
	);
	return best?.lossDb ?? 0;
}
