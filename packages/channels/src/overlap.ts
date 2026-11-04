import type { Channel, ChannelWidth } from './types.js';

// 根据中心频率和带宽计算频道占用频率范围
export function getFrequencyRange(ch: Channel, width: ChannelWidth): { low: number; high: number } {
	return {
		low: ch.frequency - width / 2,
		high: ch.frequency + width / 2
	};
}

// 判断两个频道是否可能互相干扰
export function channelsInterfere(
	a: Channel,
	b: Channel,
	widthA: ChannelWidth,
	widthB: ChannelWidth
): boolean {
	if (a.band !== b.band) {
		return false;
	}

	if (a.number === b.number) {
		return true;
	}

	if (a.band === '2.4ghz' && widthA === 20 && widthB === 20) {
		return Math.abs(a.number - b.number) < 5;
	}

	const rangeA = getFrequencyRange(a, widthA);
	const rangeB = getFrequencyRange(b, widthB);

	return rangeA.low < rangeB.high && rangeB.low < rangeA.high;
}

// 计算两个频道实际共享多少带宽，结果为 0 到 1
export function overlapFraction(
	a: Channel,
	b: Channel,
	widthA: ChannelWidth,
	widthB: ChannelWidth
): number {
	if (a.band !== b.band) return 0;
	const rangeA = getFrequencyRange(a, widthA);
	const rangeB = getFrequencyRange(b, widthB);
	const shared = Math.min(rangeA.high, rangeB.high) - Math.max(rangeA.low, rangeB.low);
	if (shared <= 0) return 0;
	const narrower = Math.min(widthA, widthB);
	return narrower > 0 ? Math.min(1, shared / narrower) : 0;
}
