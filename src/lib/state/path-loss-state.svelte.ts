/**
 * The propagation environment, as something the interface can change.
 *
 * Selecting one has three effects that must happen together, which is why this is a
 * function rather than a line in the panel: the coefficient changes, every AP's radius is
 * re-derived from it (the stored `interferenceRadius` is a cache of `rangeFromPower`, and a
 * radius left over from the old coefficient is a plan whose shape changes on reload), and
 * the project is marked dirty.
 *
 * Applying a project's own value at load time is the same sequence, minus the setting
 * write — see the `setPathLossScenario` call next to `refreshApRanges` in
 * `persistence.svelte.ts` and `export/json.ts`.
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
