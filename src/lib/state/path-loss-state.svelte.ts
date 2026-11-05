/**
 * 传播环境（界面里能切换的路径损耗场景）。
 *
 * 切换要同时做三件事，所以抽成函数：改系数、按新系数重算每个 AP 的半径（存着的 `interferenceRadius` 只是缓存，
 * 留着旧值会让方案在重新加载后变形）、把工程标成待保存。打开工程时套用它自己的值也是同一套动作，只是不写设置，
 * 见 `persistence.svelte.ts` 和 `export/json.ts` 里 `refreshApRanges` 旁边的 `setPathLossScenario`。
 */
import { refreshApRanges } from './ap-state.svelte.js';
import { projectMeta } from './project-meta.svelte.js';
import { scheduleSave } from './persistence.svelte.js';
import { pathLossScenario, setPathLossScenario, type PathLossScenario } from '$lib/rf/propagation.js';

export function applyPathLossScenario(scenario: PathLossScenario): void {
	projectMeta.pathLossScenario = scenario;
	if (pathLossScenario() !== scenario) {
		setPathLossScenario(scenario);
		refreshApRanges();
	}
	scheduleSave();
}
