/**
 * 优化器用的带种子伪随机数发生器（mulberry32）。
 *
 * 运行本身带随机性：同样的输入如果两次结果不同，前后对比就没意义，所以种子固定，
 * 而且会随结果返回，传回去就能原样重跑。优化器里三处随机都走这里：
 * k-means++ 选种子、PSO 位置抖动、PSO 速度更新。
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
