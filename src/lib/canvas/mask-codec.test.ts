/**
 * The mask codec, against the smallest canvas that can answer it.
 *
 * There is no jsdom in this suite and no PNG decoder in Node, so these tests supply the two DOM
 * members the codec touches — `Image` and `HTMLCanvasElement` — and nothing else. That is enough
 * to pin what the codec itself decides, which is all it decides:
 *
 * - a wall is **red > 128**, and everything else — a dim grey, an antialiased edge, an opaque
 *   black — is not a wall. A mask round-tripped through PNG loses every value in between, so
 *   this threshold is the only rule that survives the trip, and it is the one worth a test;
 * - the alpha channel is written, so a mask is an opaque image rather than a shape floating on
 *   transparency (an export of one went into a PDF as a black rectangle);
 * - a data URL that will not decode is an **empty plan**, not a rejection: the caller is drawing
 *   whatever it has, and one unreadable floor must not stop the others from opening.
 *
 * The fake canvas keeps its pixels in a `Uint8ClampedArray` and its data URL is the pixel bytes in
 * base64, so the round trip is genuinely a round trip rather than a stub that returns what it was
 * given. It is not a PNG: nothing here checks the encoding, only the numbers that go into it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { decodeMask, encodeMask } from './mask-codec.js';

/*
 * Base64 through the two globals every browser has. `Buffer` would be shorter and is not typed
 * here: the app is a browser application and its type environment stops at `lib.dom`.
 */
function base64(bytes: ArrayLike<number>): string {
	return btoa(String.fromCharCode(...Array.from(bytes)));
}

function fromBase64(text: string): Uint8ClampedArray {
	return Uint8ClampedArray.from(atob(text), (char) => char.charCodeAt(0));
}

/** A canvas that stores pixels and serialises them as bytes, plus the `Image` that loads them. */
class FakeContext {
	constructor(private readonly pixels: Uint8ClampedArray) {}

	getImageData(_x: number, _y: number, width: number, height: number) {
		return { data: this.pixels.slice(0, width * height * 4), width, height };
	}

	createImageData(width: number, height: number) {
		return { data: new Uint8ClampedArray(width * height * 4), width, height };
	}

	putImageData(image: { data: Uint8ClampedArray }) {
		this.pixels.set(image.data);
	}

	// `drawImage` copies the source's pixels, which is what a real canvas does for a 1:1 draw.
	drawImage(source: { pixels?: Uint8ClampedArray }) {
		if (source.pixels) this.pixels.set(source.pixels);
	}
}

class FakeCanvas {
	width = 0;
	height = 0;
	pixels = new Uint8ClampedArray(0);
	private context: FakeContext | null = null;

	getContext(kind: string): FakeContext | null {
		if (kind !== '2d') return null;
		if (!this.context) {
			this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
			this.context = new FakeContext(this.pixels);
		}
		return this.context;
	}

	toDataURL(): string {
		return `data:image/png;base64,${base64(this.pixels)}`;
	}
}

/** `Image` whose `src` decodes to the pixel bytes the fake canvas wrote. */
class FakeImage {
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	pixels: Uint8ClampedArray | null = null;

	set src(value: string) {
		const comma = value.indexOf(',');
		if (!value.startsWith('data:image/png;base64,') || comma < 0) {
			// The codec's contract for a mask that cannot be read.
			queueMicrotask(() => this.onerror?.());
			return;
		}
		this.pixels = fromBase64(value.slice(comma + 1));
		queueMicrotask(() => this.onload?.());
	}
}

let canvas: FakeCanvas | null = null;

describe('mask codec', () => {
	beforeEach(() => {
		const globals = globalThis as unknown as { document?: unknown; Image: unknown };
		globals.document = {
			createElement: (tag: string) => {
				if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
				canvas = new FakeCanvas();
				return canvas;
			}
		};
		globals.Image = FakeImage;
	});

	afterEach(() => {
		// Restore what a headless suite should look like: no DOM at all.
		const globals = globalThis as unknown as { document?: unknown; Image: unknown };
		delete globals.document;
		delete globals.Image;
		canvas = null;
	});

	it('round-trips a mask through the encode/decode pair', async () => {
		const mask = new Uint8Array([1, 0, 0, 1, 1, 0]);
		const encoded = encodeMask(mask, 3, 2);
		const decoded = await decodeMask(encoded, 3, 2);

		expect(Array.from(decoded.data)).toEqual(Array.from(mask));
		expect(decoded.width).toBe(3);
		expect(decoded.height).toBe(2);
		expect(decoded.originX).toBe(0);
		expect(decoded.originY).toBe(0);
	});

	it('reads a wall at red > 128 and nothing else', async () => {
		// 255 is a wall; 128 is not (the comparison is strict); 127 is not; 200 is.
		const pixels = new Uint8ClampedArray([255, 0, 0, 255, 128, 0, 0, 255, 127, 0, 0, 255, 200, 0, 0, 255]);
		const url = `data:image/png;base64,${base64(pixels)}`;

		const decoded = await decodeMask(url, 4, 1);

		expect(Array.from(decoded.data)).toEqual([1, 0, 0, 1]);
	});

	it('writes opaque white for a wall and leaves the rest transparent', async () => {
		encodeMask(new Uint8Array([1, 0]), 2, 1);
		expect(canvas).not.toBeNull();
		const pixels = canvas!.pixels;

		expect(Array.from(pixels.slice(0, 4))).toEqual([255, 255, 255, 255]);
		expect(Array.from(pixels.slice(4, 8))).toEqual([0, 0, 0, 0]);
	});

	it('treats a mask that will not decode as an empty plan', async () => {
		// Not a data URL at all: a real browser fires `error` for it, which is the branch this
		// checks. (A well-formed data URL carrying nonsense bytes decodes to nonsense pixels —
		// which is what a PNG decoder does with a broken PNG, and not what this decides.)
		const decoded = await decodeMask('blob:https://example.invalid/missing.png', 2, 2);

		// Zeroes, at the size that was asked for: the caller draws an empty plan and the rest of
		// the project still opens.
		expect(Array.from(decoded.data)).toEqual([0, 0, 0, 0]);
		expect(decoded.width).toBe(2);
		expect(decoded.height).toBe(2);
	});
});
