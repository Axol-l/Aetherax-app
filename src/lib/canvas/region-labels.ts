/**
 * 连通区域标记与区域操作。
 * 用于墙体块检测（点击覆盖材质）和房间检测。
 */

export interface RegionLabels {
	labels: Int32Array; // 像素 → 区域 id（-1 表示不属于任何区域）
	regionCount: number;
}

/**
 * 通过 BFS 标记二值掩码中的连通区域，适用于任意 Uint8Array，其中真值像素为待标记区域。
 * 墙体块（mask = wallData）和房间（mask = interior）共用此函数。
 */
export function labelConnectedRegions(mask: Uint8Array, w: number, h: number): RegionLabels {
	const labels = new Int32Array(w * h).fill(-1);
	let nextLabel = 0;

	for (let i = 0; i < w * h; i++) {
		if (!mask[i] || labels[i] !== -1) continue;

		const label = nextLabel++;
		const queue = [i];
		labels[i] = label;

		while (queue.length > 0) {
			const idx = queue.pop()!;
			const x = idx % w;
			const y = Math.floor(idx / w);

			if (y > 0 && mask[idx - w] && labels[idx - w] === -1) {
				labels[idx - w] = label;
				queue.push(idx - w);
			}
			if (y < h - 1 && mask[idx + w] && labels[idx + w] === -1) {
				labels[idx + w] = label;
				queue.push(idx + w);
			}
			if (x > 0 && mask[idx - 1] && labels[idx - 1] === -1) {
				labels[idx - 1] = label;
				queue.push(idx - 1);
			}
			if (x < w - 1 && mask[idx + 1] && labels[idx + 1] === -1) {
				labels[idx + 1] = label;
				queue.push(idx + 1);
			}
		}
	}

	return { labels, regionCount: nextLabel };
}

/** 向后兼容别名。 */
export const labelWallBlobs = labelConnectedRegions;
/** 向后兼容的类型别名。 */
export type WallLabels = RegionLabels;

/**
 * 标记建筑内部的封闭房间，即连续的非墙体区域。
 * 对内部掩码（可行走地面）调用 labelConnectedRegions。
 */
export function labelRooms(interior: Uint8Array, w: number, h: number): RegionLabels {
	return labelConnectedRegions(interior, w, h);
}

/**
 * 将指定区域的所有像素在目标掩码中写为给定值。
 * 用于墙体材质覆盖和房间类型赋值。
 */
export function fillRegion(
	labels: Int32Array,
	targetMask: Uint8Array,
	regionId: number,
	value: number
): void {
	for (let i = 0; i < labels.length; i++) {
		if (labels[i] === regionId) {
			targetMask[i] = value;
		}
	}
}

/** 向后兼容别名。 */
export const relabelBlob = fillRegion;

/** 将 Uint8Array 掩码编码为 PNG data URL（R 通道存储数值）。 */
export function encodeMaterialMask(mask: Uint8Array, w: number, h: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	const imgData = ctx.createImageData(w, h);
	for (let i = 0; i < mask.length; i++) {
		const j = i * 4;
		imgData.data[j] = mask[i]!;
		imgData.data[j + 1] = 0;
		imgData.data[j + 2] = 0;
		imgData.data[j + 3] = 255;
	}
	ctx.putImageData(imgData, 0, 0);
	return canvas.toDataURL('image/png');
}

/** 将 PNG data URL 解码为 Uint8Array 掩码（读取 R 通道）。 */
const decodedMaterialCache = new Map<string, Uint8Array>();

export function decodeMaterialMask(dataUrl: string, w: number, h: number): Promise<Uint8Array> {
	const cached = decodedMaterialCache.get(dataUrl);
	if (cached) return Promise.resolve(cached);
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d')!;
			ctx.drawImage(img, 0, 0);
			const data = ctx.getImageData(0, 0, w, h).data;
			const mask = new Uint8Array(w * h);
			for (let i = 0; i < mask.length; i++) {
				mask[i] = data[i * 4]!;
			}
			decodedMaterialCache.set(dataUrl, mask);
			resolve(mask);
		};
		img.onerror = () => resolve(new Uint8Array(w * h));
		img.src = dataUrl;
	});
}
