// 定义求解器的数据结构

// 节点和邻接关系
export interface Graph {
	nodes: string[];
	edges: Map<string, Set<string>>;
}

// 算法、可用频道、固定频道和超时时间
export interface SolverOptions {
	algorithm: 'greedy' | 'dsatur' | 'welsh-powell' | 'backtracking';
	availableColors: number[];
	fixedAssignments?: Map<string, number>;
	timeout?: number;
}

// 频道分配、使用颜色数量、冲突和耗时
export interface SolverResult {
	assignment: Map<string, number>;
	colorCount: number;
	conflicts: [string, string][];
	timeMs: number;
}

// 多种算法的对比结果
export interface ComparisonResult {
	results: Array<SolverResult & { algorithm: string }>;
}
