import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { CanvasEngine, LAYER_FADE_MS } from './engine.js';
import type { Layer } from './types.js';

/*
 * 没有画布的 canvas 引擎：替换 `window.devicePixelRatio` 与 `requestAnimationFrame`，画布用普通对象模拟并记录调用。
 * 这些测试只关心帧链行为，不关心像素。
 */

interface Frame {
	/** 由伪造的 `requestAnimationFrame` 调用；返回回调的 id。 */
	schedule: (cb: () => void) => number;
	/** 按顺序执行队列中的每个回调一次。 */
	flush: () => void;
	/** 累计请求的帧数。 */
	requested: () => number;
}

function fakeFrames(): Frame {
	let nextId = 1;
	let total = 0;
	let queue: Array<() => void> = [];
	return {
		schedule(cb) {
			total += 1;
			queue.push(cb);
			return nextId++;
		},
		flush() {
			const running = queue;
			queue = [];
			for (const cb of running) cb();
		},
		requested: () => total
	};
}

function fakeContext() {
	return {
		globalAlpha: 1,
		resetTransform: () => {},
		setTransform: () => {},
		clearRect: () => {},
		save: () => {},
		restore: () => {},
		drawImage: () => {}
	};
}

function fakeCanvas() {
	const ctx = fakeContext();
	// 用 `as unknown as HTMLCanvasElement` 转换：引擎只写入 `width`/`height`
	// 并读取 `style`，因此普通对象足以代替该元素。
	return { width: 0, height: 0, style: {}, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function layer(id: string, render: () => void): Layer {
	return { id, visible: true, render };
}

describe('CanvasEngine frame chain', () => {
	let frames: Frame;
	let errorSpy: MockInstance;

	beforeEach(() => {
		frames = fakeFrames();
		(globalThis as unknown as { window: unknown }).window = { devicePixelRatio: 1 };
		(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame =
			frames.schedule;
		(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		errorSpy.mockRestore();
		delete (globalThis as unknown as { document?: unknown }).document;
	});

	it('keeps drawing after a layer throws once', () => {
		let calls = 0;
		const engine = new CanvasEngine(fakeCanvas());
		engine.addLayer(
			layer('flaky', () => {
				calls += 1;
				if (calls === 1) throw new Error('first frame only');
			})
		);

		engine.start();
		frames.flush(); // 第 1 帧：抛错
		expect(calls).toBe(1);
		expect(engine.renderErrors).toBe(1);

		engine.markDirty();
		frames.flush(); // 第 2 帧：必须真正渲染
		expect(calls).toBe(2);
		expect(engine.renderErrors).toBe(0);
		expect(engine.lastRenderError).toBeNull();
	});

	it('does not let a throwing frame stop the loop from being scheduled', () => {
		const engine = new CanvasEngine(fakeCanvas());
		engine.addLayer(layer('broken', () => {
			throw new Error('always');
		}));

		engine.start();
		const before = frames.requested();
		frames.flush(); // 只跑一帧，抛错

		// 该测试固定住的缺陷：异常曾在请求下一帧之前逃逸，使画布冻结。
		expect(frames.requested()).toBeGreaterThan(before);
		expect(engine.renderErrors).toBe(1);
	});

	it('stops retrying a layer that throws every frame, and recovers on an explicit redraw', () => {
		let attempts = 0;
		const engine = new CanvasEngine(fakeCanvas());
		engine.addLayer(layer('broken', () => {
			attempts += 1;
			throw new Error('always');
		}));

		engine.start();
		for (let i = 0; i < 10; i++) frames.flush();

		// 达到上限后循环停止，而不是空转。
		expect(attempts).toBe(3);
		expect(frames.requested()).toBe(3);

		// 再显式请求一次，只会多尝试一次。
		engine.markDirty();
		frames.flush();
		expect(attempts).toBe(4);
	});

	it('logs a broken layer once per streak, not once per frame', () => {
		const engine = new CanvasEngine(fakeCanvas());
		engine.addLayer(layer('broken', () => {
			throw new Error('always');
		}));

		engine.start();
		for (let i = 0; i < 5; i++) frames.flush();
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it('honours a markDirty() issued from inside a renderer', () => {
		let renders = 0;
		const engine = new CanvasEngine(fakeCanvas());
		engine.addLayer(
			layer('self-scheduling', () => {
				renders += 1;
				if (renders === 1) engine.markDirty();
			})
		);

		engine.start();
		frames.flush();
		expect(renders).toBe(1);
		// 帧内发出的请求得以保留，因此排入了第二帧。
		frames.flush();
		expect(renders).toBe(2);
	});

	it('fades a hidden layer out, then stops drawing it', () => {
		// 渐变的中间帧要画到离屏画布，所以这里需要一个最小的 canvas 工厂。
		(globalThis as unknown as { window: unknown }).window = {
			devicePixelRatio: 1,
			matchMedia: () => ({ matches: false })
		};
		(globalThis as unknown as { document: unknown }).document = {
			createElement: () => fakeCanvas()
		};

		const engine = new CanvasEngine(fakeCanvas());
		let clock = 1000;
		engine.now = () => clock;

		let renders = 0;
		const fading = layer('fading', () => {
			renders += 1;
		});
		engine.addLayer(fading);

		engine.start();
		frames.flush();
		expect(renders).toBe(1);

		clock += 500;
		fading.visible = false;
		engine.markDirty();
		frames.flush();
		// 第一帧仍按完整不透明度绘制，随后才开始变淡。
		expect(renders).toBe(2);

		clock += LAYER_FADE_MS / 2;
		frames.flush();
		// 半透明的那一帧仍然绘制（经离屏合成）。
		expect(renders).toBe(3);

		clock += LAYER_FADE_MS;
		frames.flush();
		// 完全隐藏后不再绘制，帧链也就停止。
		expect(renders).toBe(3);
		const scheduled = frames.requested();
		frames.flush();
		expect(frames.requested()).toBe(scheduled);
	});

	it('hides a layer at once when motion is reduced', () => {
		(globalThis as unknown as { window: unknown }).window = {
			devicePixelRatio: 1,
			matchMedia: () => ({ matches: true })
		};

		const engine = new CanvasEngine(fakeCanvas());
		let renders = 0;
		const hidden = layer('instant', () => {
			renders += 1;
		});
		engine.addLayer(hidden);

		engine.start();
		frames.flush();
		expect(renders).toBe(1);

		hidden.visible = false;
		engine.markDirty();
		frames.flush();
		expect(renders).toBe(1);
		const scheduled = frames.requested();
		frames.flush();
		expect(frames.requested()).toBe(scheduled);
	});
});
