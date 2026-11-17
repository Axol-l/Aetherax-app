/**
 * 抬升面（夹层之类）对穿过它的路径造成的损耗。
 *
 * 所有评估器共用这一份规则，粗算、精算和最后的微调才不会对同一个夹层给出不同结论。
 * 间隔用世界坐标单位，平台厚度用米，所以要除以 wupm 换算。
 */
import { deckCrossing } from '../../rf/surface-height.js';
import type { EvalContext } from './types.js';

/**
 * 路径从 (x, y) 出发、离平台间隔为 gapWu 时，穿过抬升面要损失多少 dB。
 *
 * 没有抬升面就返回 0；路径不穿过平台也返回 0。
 */
export function deckLossAt(ctx: EvalContext, x: number, y: number, gapWu: number): number {
	if (ctx.surfaces.length === 0) return 0;
	const crossing = deckCrossing(ctx.surfaces, x, y, gapWu / (ctx.wupm || 1));
	return crossing ? crossing.lossDb : 0;
}
