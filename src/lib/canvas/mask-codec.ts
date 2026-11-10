/**
 * 掩码编解码：在 PNG data URL 与像素数组之间转换。
 * 墙体为 1、非墙体为 0，值从 PNG 的红色通道读回。
 */
export interface DecodedWallMask {
	data: Uint8Array;
	width: number;
	height: number;
	/** 掩码的世界坐标原点（默认 0）。 */
	originX: number;
	originY: number;
}

/** 已解码的墙体掩码；切回楼层时不必重新解码同一张 PNG。 */
const decodedMaskCache = new Map<string, DecodedWallMask>();

/** 把墙体掩码 PNG data URL 解码为 Uint8Array，便于快速查询像素。 */
export function decodeMask(
	dataUrl: string,
	width: number,
	height: number
): Promise<DecodedWallMask> {
	const cached = decodedMaskCache.get(dataUrl);
	if (cached) {
		return Promise.resolve({ ...cached, originX: 0, originY: 0 });
	}
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
			const result: DecodedWallMask = {
				data: mask,
				width,
				height,
				originX: 0,
				originY: 0
			};
			decodedMaskCache.set(dataUrl, result);
			resolve({ ...result });
		};
		// 无法解码的掩码返回空结果而不是抛错：调用方都在画已有的内容，
		// 一层楼读不出来不应影响其他楼层打开。
		img.onerror = () =>
			resolve({ data: new Uint8Array(width * height), width, height, originX: 0, originY: 0 });
		img.src = dataUrl;
	});
}

/** 把二值墙体掩码 Uint8Array 编码回 PNG data URL。 */
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
