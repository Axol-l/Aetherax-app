/**
 * 最弱层的补跑：还能不能再来一轮，以及下一轮用哪段种子。
 *
 * 整栋交替优化跑完后，未达标的“最弱层”会被单独再优化几轮（A1 的逐层保证，见
 * `runAlternatingPasses`）。这里只放那两条纯规则：预算和停止判据。放在单独的文件里，
 * 是因为它们值得单测，而 `runAlternatingPasses` 本身要起 Worker、读全局状态，测不动。
 *
 * 为什么续跑必须换种子：同一个布局输入配同一组种子，搜索是确定性的，第二轮只会原样
 * 重放出第一轮选中的方案。这个机制以前就是照着重跑，所以它花掉的那个块从来没有改变过
 * 任何东西。
 */

/**
 * 最弱层最多补跑几轮。
 *
 * 每轮都是 `restarts` 个完整块，而且交替循环本身已经把这块搜到局部最优了；换一组种子
 * 能跳到的另一个盆地值得看一次，第三次基本只剩等待。
 */
export const MAX_FLOOR_PASSES = 2;

/** 判据读的那些数，全部是面板上的整数百分比。 */
export interface FloorPassState {
	/** 已经为这层补跑了几轮。 */
	pass: number;
	/** 这一轮开始时面板上的覆盖率。 */
	before: number;
	/** 这一轮结束后面板上的覆盖率。 */
	after: number;
	/** 每层的覆盖率要求。 */
	target: number;
	/** 单层运行用几个种子重启。 */
	restarts: number;
	/** 最多补跑几轮；不填就是 `MAX_FLOOR_PASSES`。 */
	maxPasses?: number;
}

/**
 * `run` 为真时给出下一轮的种子区间起点，为假时给出停下来的原因。
 *
 * 判别联合而不是 `{ run, seedBase, stop }`：调用方拿到 `run === false` 就必然有
 * `stop`，不用再写一个 `?? 'budget'` 兜底，那个兜底只会在规则改了以后悄悄说谎。
 */
export type FloorPassDecision =
	| { run: true; seedBase: number; stop: null }
	| { run: false; seedBase: 0; stop: 'met' | 'no-gain' | 'budget' };

/**
 * 第 k 轮补跑用 `k · restarts + 1 … (k + 1) · restarts`，所以第一轮拿到的是
 * `restarts`，跳过交替循环里已经用过的 `1 … restarts`。
 *
 * 顺序就是优先级：先看达没达标（这一步之后没什么可做的），再看有没有进步（没进步说明
 * 这块的局部最优到底了），最后才看预算。
 */
export function nextFloorPass(state: FloorPassState): FloorPassDecision {
	const maxPasses = Math.max(1, Math.floor(state.maxPasses ?? MAX_FLOOR_PASSES));
	const restarts = Math.max(1, Math.floor(state.restarts));

	if (state.after >= state.target) return { run: false, seedBase: 0, stop: 'met' };
	if (!(state.after > state.before)) return { run: false, seedBase: 0, stop: 'no-gain' };
	if (state.pass >= maxPasses) return { run: false, seedBase: 0, stop: 'budget' };
	return { run: true, seedBase: (state.pass + 1) * restarts, stop: null };
}
