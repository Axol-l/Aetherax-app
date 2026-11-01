import { Camera } from './camera.js';
import type { Layer, RenderContext } from './types.js';

/**
 * How many frames in a row a throwing layer gets before the loop stops retrying.
 *
 * Three is enough for a transient failure — a cache being rebuilt mid-drag — to heal
 * itself on the next frame, and short enough that a layer broken for good stops
 * costing a frame's worth of exceptions at 60 Hz.
 */
const MAX_RENDER_ERRORS = 3;

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
	 * Frames that threw in a row, and the error the last one threw.
	 *
	 * A layer that throws does not keep its failure to itself: `render()` is the one
	 * call the frame chain hangs on. Before this was handled, a single exception left
	 * `dirty` true and `running` true while never re-arming `requestAnimationFrame`, so
	 * every later `markDirty()` took the `if (!running)` early return and the canvas
	 * was frozen for the rest of the session — with nothing on screen to say so.
	 *
	 * The count is exposed so the view can say something about it; a frame that succeeds
	 * resets it.
	 */
	renderErrors = 0;
	lastRenderError: Error | null = null;

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d')!;
		this.camera = new Camera();
		this.dpr = window.devicePixelRatio || 1;
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
		// Don't set canvas.width/height here — that clears the canvas immediately,
		// causing a flash before the next frame renders. Defer to render().
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
		 * Cleared before the draw, not after it: a renderer that calls `markDirty()` on
		 * itself — resizing a cache, scheduling work for the next frame — must not have
		 * that request swallowed by the frame it made the request in.
		 */
		this.dirty = false;
		try {
			this.render();
			this.renderErrors = 0;
			this.lastRenderError = null;
		} catch (error) {
			this.renderErrors += 1;
			this.lastRenderError = error instanceof Error ? error : new Error(String(error));
			// Once per streak: a layer that throws on every frame would otherwise write
			// sixty copies of the same stack trace a second.
			if (this.renderErrors === 1) {
				console.error('[canvas] a layer failed to render', error);
			}
			/*
			 * A failed frame is still a frame that has to happen again — leave the canvas
			 * dirty so the retry draws, rather than letting `loop` take its "nothing to do"
			 * exit on the next tick. Past the limit it goes clean, which stands the loop
			 * down with `running` false: the next `markDirty()` then buys exactly one more
			 * attempt, instead of the loop spinning on a layer that cannot render.
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
		const { ctx, camera, width, height, dpr } = this;

		// Resize backing buffer here (same frame as draw) to avoid blank flash
		const bw = width * dpr;
		const bh = height * dpr;
		if (this.canvas.width !== bw || this.canvas.height !== bh) {
			this.canvas.width = bw;
			this.canvas.height = bh;
		}

		const compositeOffscreen = (offscreen: HTMLCanvasElement, alpha = 1): void => {
			ctx.resetTransform();
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			if (alpha < 1) ctx.globalAlpha = alpha;
			ctx.drawImage(offscreen, 0, 0);
			if (alpha < 1) ctx.globalAlpha = 1;
		};

		const rc: RenderContext = { ctx, camera, width, height, dpr, compositeOffscreen };

		// Clear the full device-pixel buffer
		ctx.resetTransform();
		ctx.clearRect(0, 0, width * dpr, height * dpr);

		// Apply DPR scaling once at the top level so all layer
		// transforms operate in CSS-pixel space.
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// Render each visible layer
		for (const layer of this.layers) {
			if (layer.visible) {
				ctx.save();
				layer.render(rc);
				ctx.restore();
			}
		}
	}
}
