import type { Camera } from './camera.js';

export interface RenderContext {
	ctx: CanvasRenderingContext2D;
	camera: Camera;
	width: number;
	height: number;
	dpr: number;
	/**
	 * Composite an offscreen canvas onto the main canvas with correct DPR scaling.
	 * Use this whenever a layer renders to an offscreen canvas and needs to draw
	 * it back to the main context. Handles resetTransform + DPR restore + alpha.
	 */
	compositeOffscreen: (offscreen: HTMLCanvasElement, alpha?: number) => void;
}

export interface Layer {
	id: string;
	visible: boolean;
	render(rc: RenderContext): void;
	/**
	 * Whether the layer belongs in an exported picture. Defaults to true.
	 *
	 * This used to be decided by the exporters, which filtered on layer *ids* (`'grid'`,
	 * `'selection-rect'`): a new overlay was exported until somebody remembered to add its id
	 * to two lists. What a layer is for is the layer's own business.
	 */
	readonly exportable?: boolean;
}
