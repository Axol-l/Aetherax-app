/**
 * 掩码对象的签名，用于缓存失效。
 * 掩码内容变化时对象标识必然改变；WeakMap 把它转成字符串，缓存键可安全持有，也不会阻止掩码被回收。
 * 约定：任何写入掩码的代码都必须交出新的对象，不得依赖版本计数器。
 */
const signatures = new WeakMap<object, string>();
let next = 0;

export function maskSignature(mask: object | null | undefined): string {
	if (!mask) return 'none';
	const existing = signatures.get(mask);
	if (existing !== undefined) return existing;
	const signature = `m${++next}`;
	signatures.set(mask, signature);
	return signature;
}
