import { RENDER_BACKGROUND, type CanvasEngine } from '$canvas/engine.js';
import { projectMeta } from '$state/project-meta.svelte.js';

export interface PngOptions {
	/** Resolution multiplier (1, 2, 4). Default 2. */
	scale?: number;
}

/** Save the current view as a PNG. */
export async function exportPng(engine: CanvasEngine, options: PngOptions = {}): Promise<void> {
	const scale = options.scale ?? 2;

	const offscreen = document.createElement('canvas');
	const width = engine.canvas.width / (window.devicePixelRatio || 1);
	const height = engine.canvas.height / (window.devicePixelRatio || 1);
	offscreen.width = width * scale;
	offscreen.height = height * scale;

	const ctx = offscreen.getContext('2d')!;
	engine.drawInto(
		{ ctx, width, height, dpr: scale, background: RENDER_BACKGROUND },
		{ include: (layer) => layer.exportable !== false }
	);

	return new Promise((resolve) => {
		offscreen.toBlob((blob) => {
			if (!blob) {
				resolve();
				return;
			}
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${projectMeta.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.png`;
			a.click();
			URL.revokeObjectURL(url);
			resolve();
		}, 'image/png');
	});
}
