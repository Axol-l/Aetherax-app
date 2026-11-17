/**
 * 任意楼层热力图栅格的统一入口。
 *
 * 单层热力图由 `HeatmapLayer` 的 worker 负责；平铺/堆叠/3D 卡片以前直接在主线程
 * 调 `generateFor()`，于是每个卡片都会阻塞一次。这里把卡片也送到同一个 worker
 * 协议，主线程只负责解码掩码和组装输入。
 */
import HeatmapWorker from './heatmap-worker.ts?worker';
import type { HeatmapInput } from '$canvas/renderers/heatmap.js';

interface Pending {
	resolve: (image: { canvas: HTMLCanvasElement; x0: number; y0: number; texel: number } | null) => void;
}

export class HeatmapRasterService {
	private worker: Worker | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();

	private ensureWorker(): Worker | null {
		if (this.worker) return this.worker;
		if (typeof Worker === 'undefined') return null;
		const worker = new HeatmapWorker();
		worker.onmessage = (event: MessageEvent<{
			id: number;
			pixels: ArrayBuffer | null;
			width: number;
			height: number;
			x0: number;
			y0: number;
			texel: number;
		}>) => {
			const { id, pixels, width, height, x0, y0, texel } = event.data;
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			if (!pixels) {
				pending.resolve(null);
				return;
			}
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			canvas
				.getContext('2d')!
				.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
			pending.resolve({ canvas, x0, y0, texel });
		};
		worker.onerror = () => {
			for (const pending of this.pending.values()) pending.resolve(null);
			this.pending.clear();
			this.worker = null;
		};
		this.worker = worker;
		return worker;
	}

	/** Worker 不可用时返回 null，调用方决定是否接受主线程回退。 */
	async request(
		input: HeatmapInput
	): Promise<{ canvas: HTMLCanvasElement; x0: number; y0: number; texel: number } | null> {
		const worker = this.ensureWorker();
		if (!worker) return null;
		const id = this.nextId++;
		return new Promise((resolve) => {
			this.pending.set(id, { resolve });
			worker.postMessage({ id, key: `tile:${id}`, input });
		});
	}
}

export const heatmapRasterService = new HeatmapRasterService();
