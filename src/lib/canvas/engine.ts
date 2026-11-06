import { Camera } from './camera.js';
import type { Layer, RenderContext } from './types.js';

/**
 * 图层连续抛错的帧数上限，超过后循环停止重试。
 *
 * 达到上限后画布转为干净状态，等待下一次显式重绘。
 */
const MAX_RENDER_ERRORS = 3;

/**
 * 绘制目标；不是本引擎自己的画布时由调用方提供。
 *
 * 导出时渲染到不同比例的离屏画布，图层自身声明是否属于导出图。
 */
export interface RenderTarget {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
	/** 每个 CSS 像素对应的设备像素数；图层按 CSS 像素绘制。 */
	dpr: number;
	/** 绘制在图层之下的底色；省略时目标被清为透明。 */
	background?: string;
}

/** 应用绘制在所有内容之后的底色；导出使用它以避免透明背景。 */
export const RENDER_BACKGROUND = '#0a0c12';

export class CanvasEngine {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	camera: Camera;
	layers: Layer[] = [];

	private dirty = true;
	private running = false;
	private animFrameId = 0;
	private width = 0;
	private height = 0;
	private dpr = 1;

	/**
	 * 连续抛错的帧数与最近一次错误。
	 *
	 * 图层抛错会让整个帧链停摆，因此计数对外暴露供视图提示；成功的一帧会将其重置。
	 */
	renderErrors = 0;
	lastRenderError: Error | null = null;

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d')!;
		this.camera = new Camera();
		this.dpr = window.devicePixelRatio || 1;
	}

	/**
	 * 按绘制顺序安装图层。
	 *
	 * 数组顺序即绘制顺序，只在这一处即可确定各图层的前后关系。
	 */
	setLayers(layers: Layer[]): void {
		this.layers = [...layers];
		this.markDirty();
	}

	addLayer(layer: Layer): void {
		this.layers.push(layer);
	}

	removeLayer(id: string): void {
		this.layers = this.layers.filter((l) => l.id !== id);
	}

	getLayer(id: string): Layer | undefined {
		return this.layers.find((l) => l.id === id);
	}

	markDirty(): void {
		this.dirty = true;
		if (!this.running) {
			this.running = true;
			this.animFrameId = requestAnimationFrame(this.loop);
		}
	}

	resize(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.dpr = window.devicePixelRatio || 1;
		// 这里不设置 canvas.width/height：那会立即清空画布，在下一帧绘制前闪一下。
		// 推迟到 render() 中处理。
		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;
		this.markDirty();
	}

	start(): void {
		this.markDirty();
	}

	stop(): void {
		cancelAnimationFrame(this.animFrameId);
		this.running = false;
	}

	private loop = (): void => {
		this.animFrameId = 0;
		if (!this.dirty) {
			this.running = false;
			return;
		}
		/*
		 * 在绘制前清除，而不是绘制后：渲染器在自身内部（调整缓存大小、
		 * 安排下一帧的工作）调用 `markDirty()` 时，该请求不应被当前帧吞掉。
		 */
		this.dirty = false;
		try {
			this.render();
			this.renderErrors = 0;
			this.lastRenderError = null;
		} catch (error) {
			this.renderErrors += 1;
			this.lastRenderError = error instanceof Error ? error : new Error(String(error));
			// 每轮连续错误只记录一次：否则每帧都抛错的图层会每秒写出大量相同的堆栈。
			if (this.renderErrors === 1) {
				console.error('[canvas] a layer failed to render', error);
			}
			/*
			 * 失败的一帧仍需重来：保持画布为需要重绘状态，下一次 tick 才会继续绘制。
			 * 超过上限后转为干净状态，循环随之停止；下一次 `markDirty()` 只再试一次。
			 */
			this.dirty = this.renderErrors < MAX_RENDER_ERRORS;
		}
		if (this.dirty) {
			this.animFrameId = requestAnimationFrame(this.loop);
		} else {
			this.running = false;
		}
	};

	private render(): void {
		const bw = this.width * this.dpr;
		const bh = this.height * this.dpr;
		if (this.canvas.width !== bw || this.canvas.height !== bh) {
			this.canvas.width = bw;
			this.canvas.height = bh;
		}
		this.drawInto({ ctx: this.ctx, width: this.width, height: this.height, dpr: this.dpr });
	}

	/**
	 * 把图层绘制到非本引擎画布的上下文；是否包含某个图层由 `include` 决定。
	 * 图层自身通过 `Layer.exportable` 声明能否导出；省略 `include` 时绘制全部可见图层。
	 */
	drawInto(target: RenderTarget, options: { include?: (layer: Layer) => boolean } = {}): void {
		const { ctx, width, height, dpr } = target;

		// 清空与填充按设备像素进行：下面的图层变换使用 CSS 像素，
		// 在其上直接 clearRect 会因 DPR 而漏掉边缘。
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		if (target.background) {
			ctx.fillStyle = target.background;
			ctx.fillRect(0, 0, width * dpr, height * dpr);
		} else {
			ctx.clearRect(0, 0, width * dpr, height * dpr);
		}
		ctx.restore();

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const compositeOffscreen = (offscreen: HTMLCanvasElement, alpha = 1): void => {
			ctx.resetTransform();
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			if (alpha < 1) ctx.globalAlpha = alpha;
			ctx.drawImage(offscreen, 0, 0);
			if (alpha < 1) ctx.globalAlpha = 1;
		};

		const rc: RenderContext = { ctx, camera: this.camera, width, height, dpr, compositeOffscreen };

		for (const layer of this.layers) {
			if (!layer.visible) continue;
			if (options.include && !options.include(layer)) continue;
			ctx.save();
			layer.render(rc);
			ctx.restore();
		}
	}
}
