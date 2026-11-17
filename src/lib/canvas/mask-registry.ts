/**
 * 掩码对象的签名，用于缓存失效。
 * 掩码内容变化时对象标识必然改变；WeakMap 把它转成字符串，缓存键可安全持有，也不会阻止掩码被回收。
 * 约定：任何写入掩码的代码都必须交出新的对象，不得依赖版本计数器。
 */
const signatures = new WeakMap<object, string>();
const contentSignatures = new WeakMap<object, string>();
let next = 0;

export function maskSignature(mask: object | null | undefined): string {
	if (!mask) return 'none';
	const existing = signatures.get(mask);
	if (existing !== undefined) return existing;
	const signature = `m${++next}`;
	signatures.set(mask, signature);
	return signature;
}

/**
 * 按像素内容给出签名。
 *
 * 掩码每次从 PNG 解码都会得到新对象；只按对象身份做键会让“切走再切回”的
 * 热力图/室内缓存全部失效。像素哈希在内容不变时保持稳定。
 */
export function maskContentSignature(mask: object | null | undefined): string {
	if (!mask) return 'none';
	const existing = contentSignatures.get(mask);
	if (existing !== undefined) return existing;
	const value = mask as {
		data?: Uint8Array;
		width?: number;
		height?: number;
		originX?: number;
		originY?: number;
	};
	if (!value.data || !value.width || !value.height) return maskSignature(mask);
	let hash = 2166136261;
	const data = value.data;
	for (let i = 0; i < data.length; i++) {
		hash ^= data[i]!;
		hash = Math.imul(hash, 16777619);
	}
	const signature = `${value.width}x${value.height}@${value.originX ?? 0},${value.originY ?? 0}:${hash >>> 0}`;
	contentSignatures.set(mask, signature);
	return signature;
}
