/**
 * What a raised walking surface costs a path that crosses it.
 *
 * Shared by every evaluator for the same reason every other path term is: one rule, so the fast
 * pass, the exact pass and the polishing pass cannot disagree about a mezzanine. The gap is in
 * world units and the deck's thickness is in metres, hence the scale.
 */
import { deckCrossing } from '../../rf/surface-height.js';
import type { EvalContext } from './types.js';
/**
 * The loss a deck costs a path that crosses it.
 *
 * Shared by every evaluator for the same reason `sampleLift` is: one rule, so the fast
 * pass, the exact pass and the polishing pass cannot disagree about a mezzanine. The gap is
 * in world units and the deck's thickness is in metres, hence the scale.
 */
export function deckLossAt(ctx: EvalContext, x: number, y: number, gapWu: number): number {
	if (ctx.surfaces.length === 0) return 0;
	const crossing = deckCrossing(ctx.surfaces, x, y, gapWu / (ctx.wupm || 1));
	return crossing ? crossing.lossDb : 0;
}