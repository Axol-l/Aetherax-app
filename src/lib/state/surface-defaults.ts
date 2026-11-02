/**
 * The choices a raised surface is drawn with.
 *
 * Shared by the sidebar card and the floating toolbar: both edit the same three fields, and
 * a card and a bar that each implement "a platform copies the low height to the high one"
 * are two rules that will disagree. The rules are here, the two surfaces are only views.
 */
import { appState } from './app.svelte.js';
import { surfaceMaterial, type SurfaceKind, type SurfaceMaterialId } from '$lib/rf/surface-height.js';

/**
 * Pick the kind a new surface will be.
 *
 * A platform is level by definition, so choosing it copies the low height to the high one
 * rather than leaving a rise the drawing does not show; choosing a stair or a ramp leaves
 * the pair alone, because it already means something.
 */
export function chooseSurfaceKind(kind: SurfaceKind): void {
	appState.surfaceKind = kind;
	if (kind === 'platform') {
		appState.surfaceTopHeightM = appState.surfaceHeightM;
	} else if (appState.surfaceTopHeightM <= appState.surfaceHeightM) {
		// A stair with no rise is a platform with extra controls. Start it above the low
		// end so the first one drawn already says what it is.
		appState.surfaceTopHeightM = appState.surfaceHeightM + 1;
	}
}

/**
 * Pick the deck material for the next surface.
 *
 * The material is a preset for the loss, not a parallel setting: choosing one writes its
 * figure into `surfaceAttenuationDb`, which is what the model and the document carry.
 * `null` clears the preset and leaves the typed figure alone.
 */
export function chooseSurfaceMaterial(id: SurfaceMaterialId | null): void {
	appState.surfaceMaterial = id;
	const material = id ? surfaceMaterial(id) : null;
	if (material) appState.surfaceAttenuationDb = material.attenuationDb;
}
