/**
 * Wall masks as pixels: a data URL in, an array out, and back.
 *
 * This lived inside `wall-detect.ts`, next to 400 lines of thresholding and blob filtering,
 * and seven modules imported that file only to get it — `floor-mask.ts` on the startup path
 * among them. Reading and writing a mask has nothing to do with detecting one, and a module
 * that is imported by everything should not be the one that also owns a computer-vision
 * pipeline.
 *
 * The value is 1 for wall, 0 for not, read back from the red channel of a PNG.
 */
export interface DecodedWallMask {
	data: Uint8Array;
	width: number;
	height: number;
	/** World-space origin of the mask (default 0). */
	originX: number;
	originY: number;
}

/** Decode a wall mask PNG data URL to a Uint8Array for fast pixel lookups. */
export function decodeMask(
	dataUrl: string,
	width: number,
	height: number
): Promise<DecodedWallMask> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext('2d')!;
			ctx.drawImage(img, 0, 0);
			const data = ctx.getImageData(0, 0, width, height).data;
			const mask = new Uint8Array(width * height);
			for (let i = 0; i < mask.length; i++) {
				mask[i] = data[i * 4]! > 128 ? 1 : 0;
			}
			resolve({ data: mask, width, height, originX: 0, originY: 0 });
		};
		// A mask that will not decode is an empty plan rather than a thrown error: the callers
		// are all "draw what we have", and a project with one unreadable floor should still
		// open on the others.
		img.onerror = () =>
			resolve({ data: new Uint8Array(width * height), width, height, originX: 0, originY: 0 });
		img.src = dataUrl;
	});
}

/** Encode a binary wall mask Uint8Array back to a PNG data URL. */
export function encodeMask(data: Uint8Array, w: number, h: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	const imgData = ctx.createImageData(w, h);
	for (let i = 0; i < data.length; i++) {
		const j = i * 4;
		if (data[i]) {
			imgData.data[j] = 255;
			imgData.data[j + 1] = 255;
			imgData.data[j + 2] = 255;
			imgData.data[j + 3] = 255;
		}
	}
	ctx.putImageData(imgData, 0, 0);
	return canvas.toDataURL('image/png');
}
