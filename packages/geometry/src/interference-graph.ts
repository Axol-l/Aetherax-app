// 根据 AP 位置计算无线干扰关系

import { squaredEuclidean } from './distance.js';

// AP 的二维或三维位置和干扰半径
export interface ApPosition {
	id: string;
	x: number;
	y: number;
	z?: number; // vertical position in world units (for cross-floor interference)
	interferenceRadius: number;
}

// 两个 AP 之间的干扰边和重叠程度
export interface InterferenceEdge {
	a: string;
	b: string;
	overlapFraction: number; // 0.0 (barely touching) to 1.0 (one circle fully inside the other)
}

// 生成节点和干扰边
export function buildInterferenceGraph(aps: ApPosition[]): {
	nodes: string[];
	edges: InterferenceEdge[];
} {
	const nodes = aps.map((ap) => ap.id);
	const edges: InterferenceEdge[] = [];

	for (let i = 0; i < aps.length; i++) {
		for (let j = i + 1; j < aps.length; j++) {
			const ai = aps[i]!;
			const aj = aps[j]!;
			let distSq = squaredEuclidean({ x: ai.x, y: ai.y }, { x: aj.x, y: aj.y });
			const dz = (ai.z ?? 0) - (aj.z ?? 0);
			distSq += dz * dz;
			const radiusSum = ai.interferenceRadius + aj.interferenceRadius;
			if (distSq < radiusSum * radiusSum) {
				const dist = Math.sqrt(distSq);
				const minRadius = Math.min(ai.interferenceRadius, aj.interferenceRadius);
				const overlap = radiusSum - dist;
				const overlapFraction = Math.min(1, overlap / minRadius);
				edges.push({ a: ai.id, b: aj.id, overlapFraction });
			}
		}
	}

	return { nodes, edges };
}
