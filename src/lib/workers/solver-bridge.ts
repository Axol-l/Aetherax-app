/**
 * 主线程和信道分配求解器 Worker 之间的桥接。
 *
 * 求解在 Worker 里跑，主线程这边把图发过去、等结果。Worker 只能传结构化克隆的数据，
 * `Map` 传不了，所以结果里的 assignment 用数组传输，收到后再转成 `Map`。
 */
import type { SolverResult, ComparisonResult } from '@aetherax/solver';

type Algorithm = 'greedy' | 'dsatur' | 'welsh-powell' | 'backtracking';

interface SerializedGraph {
	nodes: string[];
	edges: [string, string[]][];
}

interface SerializedSolverResult {
	assignment: [string, number][];
	colorCount: number;
	conflicts: [string, string][];
	timeMs: number;
}

function deserializeResult(data: SerializedSolverResult): SolverResult {
	return {
		...data,
		assignment: new Map(data.assignment)
	};
}

export class SolverBridge {
	private worker: Worker | null = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private pendingResolve: ((value: any) => void) | null = null;
	private pendingReject: ((reason: unknown) => void) | null = null;

	private getWorker(): Worker {
		if (!this.worker) {
			this.worker = new Worker(
				new URL('../../../packages/solver/src/worker.ts', import.meta.url),
				{ type: 'module' }
			);
			this.worker.onmessage = (event) => {
				const { data } = event;
				if (data.type === 'result' && this.pendingResolve) {
					this.pendingResolve(deserializeResult(data.data));
					this.pendingResolve = null;
					this.pendingReject = null;
				} else if (data.type === 'comparison' && this.pendingResolve) {
					const results: ComparisonResult = {
						results: data.data.results.map((r: SerializedSolverResult & { algorithm: string }) => ({
							...deserializeResult(r),
							algorithm: r.algorithm
						}))
					};
					this.pendingResolve(results);
					this.pendingResolve = null;
					this.pendingReject = null;
				}
			};
			this.worker.onerror = (err) => {
				if (this.pendingReject) {
					this.pendingReject(err);
					this.pendingResolve = null;
					this.pendingReject = null;
				}
			};
		}
		return this.worker;
	}

	solve(
		graph: SerializedGraph,
		options: {
			algorithm: Algorithm;
			availableColors: number[];
			fixedAssignments?: [string, number][];
			timeout?: number;
		}
	): Promise<SolverResult> {
		return new Promise((resolve, reject) => {
			// 上一个请求还没结束的话，直接让它失败
			if (this.pendingReject) {
				this.pendingReject(new Error('Superseded by new request'));
			}
			this.pendingResolve = resolve;
			this.pendingReject = reject;
			this.getWorker().postMessage({ type: 'solve', graph, options });
		});
	}

	compare(
		graph: SerializedGraph,
		options: {
			availableColors: number[];
			fixedAssignments?: [string, number][];
			timeout?: number;
		}
	): Promise<ComparisonResult> {
		return new Promise((resolve, reject) => {
			// 上一个请求还没结束的话，直接让它失败
			if (this.pendingReject) {
				this.pendingReject(new Error('Superseded by new request'));
			}
			this.pendingResolve = resolve;
			this.pendingReject = reject;
			this.getWorker().postMessage({ type: 'compare', graph, options });
		});
	}

	terminate(): void {
		this.worker?.terminate();
		this.worker = null;
	}
}
