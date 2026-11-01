/**
 * The antenna each access point is evaluated with, at one layout.
 *
 * A wall-mounted unit's pattern turns with the wall it is on, so its profile is a function of
 * *where it is*: the search slides it along a wall, around corners too, and each of those
 * positions has its own direction. Every other mounting's profile is fixed for the run.
 *
 * Separate from the worker because it is a rule about antennas rather than about searching, and
 * because it is the rule the panel and the worker have to share: an upright omni scored for a
 * wall mount is a plan optimised for a device nobody has.
 */
import type { AntennaProfile } from '../../rf/antenna.js';
import { antennaProfileForMount } from '../../rf/antenna.js';
import type { Band } from '@aetherax/channels';
import { facingAt } from './placement.js';
import type { EvalContext, Position } from './types.js';
/**
 * The antenna profile of every AP being placed, at one layout.
 *
 * A wall-mounted unit's pattern turns with the wall it is on, so its profile is a
 * function of *where it is*: the search slides it along a wall, around corners too, and
 * each of those positions has its own direction. Every other mounting's profile is
 * fixed for the run, so a run with no wall mounts gets the array built once and no
 * per-evaluation work at all.
 */
export function resolveApProfiles(positions: Position[], ctx: EvalContext): AntennaProfile[] {
	if (!ctx.wallPlacement || !ctx.wallMounted.some(Boolean)) return ctx.apProfiles;
	const out = ctx.apProfiles.slice();
	for (let a = 0; a < positions.length; a++) {
		if (!ctx.wallMounted[a]) continue;
		const facing = facingAt(ctx.wallPlacement, positions[a]!.x, positions[a]!.y, ctx.w, ctx.h);
		// Off the band (the search has just moved it, or the mask has no wall there):
		// the profile the payload described still applies, which is where the run
		// started.
		if (facing === null) continue;
		out[a] = antennaProfile({ ...ctx.apSources[a]!, mount: 'wall', facingDeg: facing });
	}
	return out;
}

/**
 * An access point's antenna profile, from what the payload carries.
 *
 * The broadside floor is per band and not sent: it is a property of the antenna
 * class rather than a per-AP setting, and both ends read it from the same table. The
 * mount and the facing *are* sent, because a wall-mounted unit has a horizontal cut
 * and the rule that gives it one lives in `rf/antenna.ts` so that this worker and the
 * main thread cannot disagree about it.
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