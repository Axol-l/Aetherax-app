/**
 * 热力图生成 Worker。
 *
 * 单层热力图的全平面扫描从主线程移到这里；结果用 OffscreenCanvas 传回。
 * 卡片缩略图仍可在主线程用 `generateFor` 生成。
 */
import { HeatmapLayer, type HeatmapInput } from '$canvas/renderers/heatmap.js';

interface HeatmapWorkerRequest {
	id: number;
	input: HeatmapInput;
}

self.onmessage = (event: MessageEvent<HeatmapWorkerRequest>) => {
	const { id, input } = event.data;
	const layer = new HeatmapLayer();
	layer.reflectingWalls = input.reflectingWalls ?? [];
	layer.wallHeightM = input.wallHeightM ?? 3;
	layer.metric = input.metric ?? 'rssi';
	layer.receiverPolarizationAngleDeg = input.receiverPolarizationAngleDeg ?? 0;

	const result = layer.generateFor(input);
	if (!result) {
		self.postMessage({ id, canvas: null });
		return;
	}
	self.postMessage(
		{
			id,
			canvas: result.canvas,
			x0: result.x0,
			y0: result.y0,
			texel: result.texel
		},
		[result.canvas as unknown as Transferable]
	);
};
