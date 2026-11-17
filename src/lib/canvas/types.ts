import type { Camera } from './camera.js';

export interface RenderContext {
	ctx: CanvasRenderingContext2D;
	camera: Camera;
	width: number;
	height: number;
	dpr: number;
	/**
	 * 把离屏画布按正确的 DPR 缩放合成到主画布。
	 * 图层先渲染到离屏画布再回绘时使用，内部处理 resetTransform、DPR 还原与透明度。
	 */
	compositeOffscreen: (offscreen: HTMLCanvasElement, alpha?: number) => void;
}

export interface Layer {
	id: string;
	visible: boolean;
	render(rc: RenderContext): void;
	/**
	 * 该图层是否属于导出的图片，默认为 true。
	 * 由图层自身声明，而非由导出器按图层 id 过滤。
	 */
	readonly exportable?: boolean;
}
