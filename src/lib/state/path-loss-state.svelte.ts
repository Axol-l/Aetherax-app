/**
 * 传播环境
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
