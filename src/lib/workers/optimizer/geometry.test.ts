import { describe, expect, it } from 'vitest';
import { GeometryCache } from './geometry.js';

/*
 * 这里测的是：Worker 收到了什么几何，以及允许拿什么来回答。
 *
 * 真实户型上消息里大半是几十 MB 的掩码，而同一层的几何在重启和多趟运行之间都不变。
 * 复用很值钱，但复用错了不会报错——用别层的掩码照样能算出一个看着很合理的布局。
 */

const A = { id: 'a', geometry: { name: 'plan A' } };
const B = { id: 'b', geometry: { name: 'plan B' } };

describe('GeometryCache', () => {
	it('takes the geometry a message carries, and remembers it', () => {
		const cache = new GeometryCache<{ name: string }>();

		expect(cache.resolve(A, 'a', false)).toBe(A.geometry);
		// 下一条消息只报 id，不再重复传几何。
		expect(cache.resolve(null, 'a', true)).toBe(A.geometry);
	});

	it('replaces what it holds when another plan arrives', () => {
		const cache = new GeometryCache<{ name: string }>();
		cache.resolve(A, 'a', false);
		cache.resolve(B, 'b', false);

		expect(cache.resolve(null, 'b', true)).toBe(B.geometry);
		// 旧图已经没了：再报旧 id 不能把新图返回去。
		expect(cache.resolve(null, 'a', true)).toBeNull();
	});

	it('refuses a message that names a plan it does not hold', () => {
		const cache = new GeometryCache<{ name: string }>();

		// 这个缓存存在的意义：桥接层以为 Worker 已经加载了，其实是个什么都没收到的新 Worker。
		expect(cache.resolve(null, 'a', true)).toBeNull();

		cache.resolve(A, 'a', false);
		expect(cache.resolve(null, 'b', true)).toBeNull();
	});

	it('refuses a message that carries no plan and asks for none', () => {
		const cache = new GeometryCache<{ name: string }>();
		cache.resolve(A, 'a', false);

		// 没带几何、也没声明加载过：拒绝能把调用方的 bug 变成报错，而不是拿旧掩码跑一趟。
		expect(cache.resolve(null, 'a', false)).toBeNull();
		expect(cache.resolve(null, undefined, true)).toBe(A.geometry);
	});
});
