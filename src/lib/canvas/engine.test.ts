import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { CanvasEngine } from './engine.js';
import type { Layer } from './types.js';

/*
 * A canvas engine with no canvas.
 *
 * There is no jsdom in this project, so the two platform objects the engine touches —
 * `window.devicePixelRatio` and `requestAnimationFrame` — are stubbed here, and the
 * canvas is a plain object that answers `getContext('2d')` with a recorder. That is
 * enough because these tests are about the *frame chain*, not about pixels: what the
 * loop does when a layer throws, and whether it ever draws again.
 */

interface Frame {
	/** Called by the fake `requestAnimationFrame`; returns the callback's id. */
	schedule: (cb: () => void) => number;
	/** Run every queued callback once, in order. */
	flush: () => void;
	/** How many frames were requested in total. */
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
	// `as unknown as HTMLCanvasElement`: the engine assigns `width`/`height` and reads
	// `style`, and nothing else, so a plain object stands in for the element.
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
		frames.flush(); // frame 1: throws
		expect(calls).toBe(1);
		expect(engine.renderErrors).toBe(1);

		engine.markDirty();
		frames.flush(); // frame 2: must actually render
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
		frames.flush(); // one frame, throws

		// The bug this pins: the exception used to escape before the next frame was
		// requested, leaving the canvas frozen.
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

		// Three attempts, then the loop stands down instead of spinning.
		expect(attempts).toBe(3);
		expect(frames.requested()).toBe(3);

		// One more explicit request gets exactly one more attempt.
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
		// The request made during the frame survived it, so a second frame is queued.
		frames.flush();
		expect(renders).toBe(2);
	});
});
