/**
 * 热力图的着色下限。
 *
 * 它以前是优化器设置里的 “Min signal”，可以单独调。但那个旋钮只改画面、不改覆盖率，
 * 同一个弹窗里还放着真正参与评分的 Coverage threshold，两个 −70 dBm 的滑块摆在上下相邻的
 * 位置，几乎必然被读成同一件事——拖上面那个，彩色区域变了、Coverage 却不动。
 *
 * 现在它不再是设置，由覆盖门限推出来：比门限低 `HEATMAP_BELOW_THRESHOLD_DB`。比门限更低的
 * 部分仍然着色，为的是看得见“差一点就覆盖”的区域；门限以上则和覆盖率读数严格对应。
 */
import { coverageThresholdDbm } from '../rf/propagation.js';

/**
 * 显示下限比判定门限低多少 dB。
 *
 * 取 10 是一个量级：既能让热点边缘的梯度看得见，又不至于把整张图涂满噪声。
 */
export const HEATMAP_BELOW_THRESHOLD_DB = 10;

/** 热力图着色下限，单位 dBm。 */
export function heatmapDisplayFloorDbm(): number {
	// 下限不超过旧滑块的范围，免得换了一个工程后色阶突然压到噪声底。
	return Math.max(-95, coverageThresholdDbm() - HEATMAP_BELOW_THRESHOLD_DB);
}
