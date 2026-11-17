// 维护干扰图

import type { Graph } from './types.js';

export function createGraph(): Graph {
	return { nodes: [], edges: new Map() };
}

// 加入节点
export function addNode(graph: Graph, id: string): void {
	if (!graph.nodes.includes(id)) {
		graph.nodes.push(id);
	}
	if (!graph.edges.has(id)) {
		graph.edges.set(id, new Set());
	}
}

// 加入两个节点之间的无向边
export function addEdge(graph: Graph, a: string, b: string): void {
	addNode(graph, a);
	addNode(graph, b);
	graph.edges.get(a)!.add(b);
	graph.edges.get(b)!.add(a);
}

// 获取邻居节点
export function neighbors(graph: Graph, id: string): string[] {
	const adj = graph.edges.get(id);
	return adj ? Array.from(adj) : [];
}

// 获取节点度数，即邻居数量
export function degree(graph: Graph, id: string): number {
	const adj = graph.edges.get(id);
	return adj ? adj.size : 0;
}
