/**
 * 热力图生成 Worker。
 *
 * 单层热力图的全平面扫描从主线程移到这里；结果用 OffscreenCanvas 传回。
 * 卡片缩略图仍可在主线程用 `generateFor` 生成。
 */
import { HeatmapLayer, type HeatmapInput } from '$canvas/renderers/heatmap.js';

interface HeatmapWorkerRequest {
	id: number;
	key: string;
	input: HeatmapInput;
}

self.onmessage = (event: MessageEvent<HeatmapWorkerRequest>) => {
	const { id, key, input } = event.data;
	const layer = new HeatmapLayer();
	layer.reflectingWalls = input.reflectingWalls ?? [];
	layer.wallHeightM = input.wallHeightM ?? 3;
	layer.metric = input.metric ?? 'rssi';
	layer.receiverPolarizationAngleDeg = input.receiverPolarizationAngleDeg ?? 0;

	const result = layer.generateFor(input);
	if (!result) {
		self.postMessage({ id, key, pixels: null });
		return;
	}
	const context = (result.canvas as unknown as OffscreenCanvas).getContext('2d')!;
	const image = context.getImageData(0, 0, result.canvas.width, result.canvas.height);
	let colored = 0;
	for (let i = 0; i < image.data.length; i += 4) {
		const r = image.data[i]!;
		const g = image.data[i + 1]!;
		const b = image.data[i + 2]!;
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		if (max - min > 24 && max > 40) colored++;
	}
	self.postMessage(
		{
			id,
			key,
			pixels: image.data.buffer,
			colored,
			width: image.width,
			height: image.height,
			x0: result.x0,
			y0: result.y0,
			texel: result.texel
		},
		[image.data.buffer]
	);};
