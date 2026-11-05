/**
 * 在某个布局下，每个接入点评估时用哪个天线方向图。
 *
 * 壁挂设备的方向图跟着它所在的那面墙转，是“位置”的函数：搜索会让它沿墙滑、还有可能拐角，
 * 每个位置的朝向都不一样。其他安装方式在整次运行里固定不变。
 * 这条规则面板和 Worker 必须共用，否则会按一台谁都没有的设备去优化。
 */
import type { AntennaProfile } from '../../rf/antenna.js';
import { antennaProfileForMount } from '../../rf/antenna.js';
import type { Band } from '@aetherax/channels';
import { facingAt } from './placement.js';
import type { EvalContext, Position } from './types.js';
/**
 * 算出这次布局下每个 AP 的天线方向图。
 *
 * 只有壁挂设备会随位置变；没有壁挂时直接把 `ctx.apProfiles` 原样返回，不做任何逐次计算。
 */
export function resolveApProfiles(positions: Position[], ctx: EvalContext): AntennaProfile[] {
	if (!ctx.wallPlacement || !ctx.wallMounted.some(Boolean)) return ctx.apProfiles;
	const out = ctx.apProfiles.slice();
	for (let a = 0; a < positions.length; a++) {
		if (!ctx.wallMounted[a]) continue;
		const facing = facingAt(ctx.wallPlacement, positions[a]!.x, positions[a]!.y, ctx.w, ctx.h);
		// 落在墙带外了（搜索刚把它移走，或者掩码那里根本没有墙）：
		// 继续用消息里给的方向图，也就是运行开始时的那份。
		if (facing === null) continue;
		out[a] = antennaProfile({ ...ctx.apSources[a]!, mount: 'wall', facingDeg: facing });
	}
	return out;
}

/**
 * 按消息里给的字段算出某个 AP 的天线方向图。
 *
 * 各频段的 broadside 基准值不走消息：它属于天线类别，不是单个 AP 的设置，两端读同一张表。
 * 安装方式（`mount`）和朝向（`facingDeg`）必须传：壁挂设备要用水平切面，而这条规则在 `rf/antenna.ts` 里，
 * 这样 Worker 和主线程才不会算出两个不同的结果。
 */
export function antennaProfile(ap: {
	beamwidthDeg?: number;
	aimDeg?: number;
	mount?: string | null;
	facingDeg?: number;
	band: Band;
}): AntennaProfile {
	return antennaProfileForMount({
		band: ap.band,
		beamwidthDeg: ap.beamwidthDeg,
		aimDeg: ap.aimDeg,
		mount: ap.mount,
		facingDeg: ap.facingDeg
	});
}