/**
 * 掩码编解码的测试：套件没有 jsdom 与 PNG 解码器，因此只提供编解码用到的
 * `Image` 与 `HTMLCanvasElement` 两个替身。
 * 覆盖红色通道阈值、不透明像素的写入，以及无法解码时返回空结果这三条规则。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { decodeMask, encodeMask } from './mask-codec.js';

/* 用浏览器自带的两个全局函数做 Base64 编解码；本应用是浏览器应用，类型环境止于 `lib.dom`。 */
function base64(bytes: ArrayLike<number>): string {
	return btoa(String.fromCharCode(...Array.from(bytes)));
}

function fromBase64(text: string): Uint8ClampedArray {
	return Uint8ClampedArray.from(atob(text), (char) => char.charCodeAt(0));
}

/** 存储像素并以字节形式序列化的画布上下文。 */
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

	// `drawImage` 复制源像素，与真实画布在 1:1 绘制时的行为一致。
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

/** `src` 会解码为假画布所写像素字节的 `Image`。 */
class FakeImage {
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	pixels: Uint8ClampedArray | null = null;

	set src(value: string) {
		const comma = value.indexOf(',');
		if (!value.startsWith('data:image/png;base64,') || comma < 0) {
			// 编解码器对无法读取的掩码的约定行为。
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
		// 恢复无头测试套件应有的状态：完全没有 DOM。
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
		// 红色大于 128 为墙体；比较是严格的，等于 128 不算墙体。
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
		// 根本不是 data URL：真实浏览器会触发 `error`，这里验证的正是该分支。
		// 格式合法但内容无意义的数据不在此列。
		const decoded = await decodeMask('blob:https://example.invalid/missing.png', 2, 2);

		// 全零，尺寸与请求一致：调用方会画一个空方案，项目其余部分仍可打开。
		expect(Array.from(decoded.data)).toEqual([0, 0, 0, 0]);
		expect(decoded.width).toBe(2);
		expect(decoded.height).toBe(2);
	});
});
