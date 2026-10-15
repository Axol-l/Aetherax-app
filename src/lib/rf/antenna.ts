/**
 * The antenna's vertical cut: where an access point radiates, in the plane that
 * decides how far down a client is.
 *
 * The site-general model this app is built on (`PL = PL0 + 10·n·log10(d)`) has no
 * antenna in it at all: every access point radiated equally in every direction, so
 * a client 20 m away on the same floor and a client directly under the AP were
 * given the same treatment. That is wrong in a way that matters, and the error is
 * entirely in the vertical plane:
 *
 * - An indoor access point is an upright omni — its pattern is a doughnut around
 *   its own axis, i.e. **peaked near the horizon** and rolling off towards its
 *   ends. A same-floor client is always within about 20° of the horizon beyond
 *   4 m, so it sits near the peak; a client **directly below** (or an AP directly
 *   above a client — the multi-floor case) is at 90° off it, which is the weakest
 *   part of the pattern.
 * - The horizontal plane, by contrast, is nearly flat for these devices, so an
 *   *azimuth* pattern would buy little for the ceiling hardware this is written
 *   for — which is why the ceiling case has none. A **wall-mounted** unit is the
 *   exception: it radiates into the room and is heavily attenuated behind, so its
 *   horizontal cut is what decides where coverage goes, and `azimuthGainDb` below
 *   supplies it. See `docs/PHYSICAL_MODELS.md` D2 and D2a.
 *
 * The shape below is a two-anchor profile calibrated against the vendor pattern
 * files analysed in D2 (Ubiquiti U6/U7 series, 2.4/5/6 GHz, kept locally and
 * untracked): `-3 dB` exactly at the half-power angle, then a smoothstep down to a
 * broadside floor whose depth is per band. Fitting the measured 5 GHz cuts, a
 * 60° beamwidth with a 12 dB floor reproduces them within about a decibel over the
 * angles a same-floor client actually sits at (35°/54°/70° off the peak for 2 m /
 * 1 m / 0.5 m horizontally at the default ceiling height, where the measurement
 * reads 2-7 / 4-8 / 5-10 dB down); the 2.4 GHz cuts are consistently wider and
 * shallower, hence 120° and 7 dB.
 *
 * Absolute orientation is deliberately not taken from those files: each of their
 * two cuts is normalised to its own peak with no reference axis, so which way the
 * doughnut points cannot be recovered. The profile therefore states it — the peak
 * is `aimDeg` from the horizontal, positive downwards — and that is what the
 * parameter means.
 */

/**
 * The vertical pattern of one access point.
 *
 * `floorDb` is the level at broadside (90° off the peak, and beyond) relative to
 * the peak. It is not editable: it comes from the band, together with the
 * default beamwidth, because it is a property of the antenna class rather than
 * something a planner tunes. The two editable numbers are the beamwidth and the
 * aim, which are the two that change where coverage goes.
 */
export interface AntennaProfile {
	/** −3 dB beamwidth of the vertical cut, in degrees. */
	beamwidthDeg: number;
	/**
	 * Where the pattern's peak points, in degrees from the horizontal.
	 *
	 * **Signed**: positive aims down, negative aims up, zero is level. The peak is
	 * the direction a client has to be in to get the full gain, so one signed number
	 * covers both ends of the axis without a second "which way up" switch:
	 *
	 * - `0` — an upright omni, and the default. Its doughnut is level, so a client
	 *   out on the floor is near the peak and one straight below is not.
	 * - `+45…+90` — aimed at the floor: a panel against a ceiling, or a unit mounted
	 *   flat to the slab with a patch antenna.
	 * - `−45…−90` — aimed up: a unit standing on a desk or the floor, radiating into
	 *   the room instead of into the slab under it.
	 *
	 * It is deliberately *not* derived from the mounting height. The height says
	 * where the access point is, not which way its antenna faces, and for the
	 * ceiling hardware this is written for the two are independent: the antennas are
	 * vertical in every mount, which is what makes the pattern a level doughnut.
	 */
	aimDeg: number;
	/** Level at broadside (90° off the peak) and beyond, in dB below it. */
	floorDb: number;
	/**
	 * The **horizontal** cut, which only hardware that radiates forwards has.
	 *
	 * An upright omni is a doughnut about its own axis, so its azimuth cut is very
	 * nearly a circle (the vendor cuts on hand ripple by 3–8 dB, see D2) and an
	 * azimuth term would buy nothing — which is why the ceiling case leaves these
	 * unset and `azimuthLossDb` returns 0.
	 *
	 * A wall-mounted unit is not that: it radiates into the room and is heavily
	 * attenuated behind, so the plan direction it faces decides where coverage goes,
	 * and the vertical cut alone would give a client standing behind it the same
	 * level as one in front. `facingDeg` is that direction, and the other two
	 * describe the shape of the cut.
	 */
	facingDeg?: number;
	/** −3 dB width of the horizontal cut, in degrees. Absent or 180 = no cut. */
	azBeamwidthDeg?: number;
	/** Level straight behind, relative to straight in front, in dB. */
	frontToBackDb?: number;
}

/**
 * Defaults per band, from the vendor cuts: the 2.4 GHz patterns are wide and
 * shallow, 5 and 6 GHz noticeably narrower and deeper.
 */
const BAND_DEFAULTS: Record<string, { beamwidthDeg: number; floorDb: number }> = {
	'2.4ghz': { beamwidthDeg: 120, floorDb: 7 },
	'5ghz': { beamwidthDeg: 60, floorDb: 12 },
	'6ghz': { beamwidthDeg: 60, floorDb: 13 }
};

/** Widest beamwidth that still means "a beam": at 180° the pattern is flat. */
export const MAX_BEAMWIDTH_DEG = 180;
/**
 * How far the peak may be aimed from the horizontal.
 *
 * 90° is straight down or straight up, which is as far as "aimed at the floor" or
 * "aimed at the ceiling" can go before it stops being an aim and becomes a
 * mounting orientation.
 */
export const MAX_AIM_DEG = 90;

/** The vertical pattern a new access point starts with on this band. */
export function defaultAntenna(beamwidthDeg: number | null, band: string): AntennaProfile {
	const fallback = BAND_DEFAULTS[band] ?? BAND_DEFAULTS['5ghz']!;
	return {
		beamwidthDeg: beamwidthDeg ?? fallback.beamwidthDeg,
		aimDeg: 0,
		floorDb: fallback.floorDb
	};
}

/**
 * The profile of one access point, from the fields an AP or a worker payload carries.
 *
 * This is the only place that decides that a **wall-mounted** unit has a horizontal
 * cut and an upright omni does not, so the editor's panel, the heatmap, the live
 * coverage pass and the optimiser's worker cannot disagree about it — the worker
 * cannot import the state module (`$state` is not worker-safe), which is why the
 * decision lives here in the pure layer rather than beside `AccessPoint`.
 *
 * `mount` is a plain string rather than the state module's `ApMount` for the same
 * reason: this file stays free of application state.
 */
export function antennaProfileForMount(input: {
	band: string;
	beamwidthDeg?: number | null;
	aimDeg?: number | null;
	mount?: string | null;
	facingDeg?: number | null;
}): AntennaProfile {
	const base = defaultAntenna(input.beamwidthDeg ?? null, input.band);
	const profile: AntennaProfile = {
		beamwidthDeg: input.beamwidthDeg ?? base.beamwidthDeg,
		aimDeg: input.aimDeg ?? 0,
		floorDb: base.floorDb
	};
	if (input.mount !== 'wall') return profile;
	return {
		...profile,
		facingDeg: input.facingDeg ?? 0,
		...WALL_MOUNT_AZIMUTH
	};
}

/** The band's broadside floor, for a profile whose beamwidth the user has edited. */
export function antennaFloorDb(band: string): number {
	return (BAND_DEFAULTS[band] ?? BAND_DEFAULTS['5ghz']!).floorDb;
}

/**
 * Gain of the vertical cut, in dB relative to its peak.
 *
 * `angleBelowHorizonDeg` is signed: positive for a ray that goes *down* from the
 * access point, negative for one that goes up. The offset from the peak is
 * therefore `|angle − aim|`, which is what makes an aimed pattern weaker behind
 * the aim than in front of it — the whole point of aiming at all.
 *
 * Below the half-power angle the curve is the usual squared-offset rolloff; past
 * it a smoothstep carries the level to the broadside floor, so the curve has no
 * kink where the two meet and none at 90°. Beyond 90° the floor holds: a
 * measured cut bottoms out at −23 dB and is smoothed, so it has no usable null,
 * and inventing one would make the model claim coverage holes it cannot know.
 */
export function elevationGainDb(angleBelowHorizonDeg: number, profile: AntennaProfile): number {
	/*
	 * A 180° beamwidth is the documented way to say "no vertical pattern at all" —
	 * it is what reproduces the figures recorded before this module existed, and
	 * what a flat-profile test asserts. It cannot come out of the shape below: a
	 * half-power angle of 90° with a −3 dB anchor is a parabola, not a constant.
	 */
	if (profile.beamwidthDeg >= MAX_BEAMWIDTH_DEG) return 0;
	// 0 would put the half-power angle at the peak, which is no beam at all.
	const half = Math.max(1, profile.beamwidthDeg / 2);
	const offset = Math.abs(angleBelowHorizonDeg - profile.aimDeg);
	if (offset <= half) return -3 * (offset / half) ** 2;
	if (offset >= 90) return -profile.floorDb;
	const t = (offset - half) / (90 - half);
	return -3 - (profile.floorDb - 3) * t * t * (3 - 2 * t);
}

/**
 * The angle below the horizon of the ray from an access point to a point, in
 * degrees, from the vertical and horizontal parts of that ray.
 *
 * Positive downwards, negative when the target is above the access point — see
 * `elevationGainDb`.
 */
export function angleBelowHorizonDeg(vertical: number, horizontal: number): number {
	return (Math.atan2(vertical, horizontal) * 180) / Math.PI;
}

/**
 * The vertical cut's loss for one ray, in dB, as a **positive** number to be added
 * to the other losses on that path.
 *
 * This exists because `elevationGainDb` returns a gain *relative to the peak*, which
 * is negative for every direction but one — and subtracting a negative number adds
 * signal. That is exactly the mistake this function was written to stop: the
 * heatmap and the coverage pass both had `level -= elevationGainDb(...)`, which
 * made a *narrower* beam paint a *larger* covered area. The optimiser worker,
 * written against a positive loss from the start, was the only one of the three
 * that was right, which is the sort of thing a shared helper and a sign test are
 * for.
 */
export function antennaLossDb(
	profile: AntennaProfile,
	vertical: number,
	horizontal: number
): number {
	return -elevationGainDb(angleBelowHorizonDeg(vertical, horizontal), profile);
}

/**
 * The horizontal cut assumed for a wall-mounted access point.
 *
 * A wall unit radiates into the room and is heavily attenuated behind, and this
 * repository has no datasheet for one: the vendor pattern files on hand are ceiling
 * omnis, whose azimuth cuts ripple by 3–8 dB and would say a unit mounted on a wall
 * shines backwards almost as well as forwards. So these are **assumed** values of
 * the class — a wall-plate access point's horizontal cut is roughly this wide and
 * roughly this far down behind — and they are the one place to change when a real
 * datasheet arrives. The vertical cut keeps the band's own defaults, which are
 * calibrated.
 */
export const WALL_MOUNT_AZIMUTH: { azBeamwidthDeg: number; frontToBackDb: number } = {
	azBeamwidthDeg: 90,
	frontToBackDb: 20
};

/** An angle folded into (−180, 180]. */
export function wrap180(deg: number): number {
	let a = deg % 360;
	if (a > 180) a -= 360;
	if (a <= -180) a += 360;
	return a;
}

/**
 * A facing folded into [0, 360): how a direction is stored, shown and written out.
 *
 * The pattern itself does not care — `azimuthGainDb` folds whatever it is given —
 * but a field, a JSON export and a `-90` that means "north" are three ways of
 * describing one angle, so the stored value is kept canonical.
 */
export function normaliseBearing(deg: number): number {
	const a = deg % 360;
	return a < 0 ? a + 360 : a;
}

/** The plan bearing of a ray, in degrees from +x towards +y, i.e. `atan2`'s angle. */
export function bearingDeg(dx: number, dy: number): number {
	return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * Gain of the horizontal cut, in dB relative to its own peak.
 *
 * The same two-anchor shape as the vertical cut — `−3·(offset/half)²` to the
 * half-power angle, then a smoothstep — with two differences that matter:
 *
 * - the offset is the bearing *from the facing direction*, which is what makes a
 *   wall-mounted unit's coverage depend on the plan direction a client is in;
 * - the far anchor is **180°** (straight behind) rather than 90°, because that is
 *   where this cut's floor is. Reusing the vertical cut's 90° asymptote here would
 *   put a wall unit's back lobe at its front, which is the error this exists to
 *   avoid.
 *
 * A profile with no horizontal cut — every ceiling mount, and every profile written
 * before wall mounts existed — returns 0: the model stays exactly what it was.
 */
export function azimuthGainDb(bearing: number, profile: AntennaProfile): number {
	const beamwidth = profile.azBeamwidthDeg;
	if (beamwidth === undefined || beamwidth >= MAX_BEAMWIDTH_DEG) return 0;
	const half = Math.max(1, beamwidth / 2);
	const back = Math.max(3, profile.frontToBackDb ?? 20);
	const offset = Math.abs(wrap180(bearing - (profile.facingDeg ?? 0)));
	if (offset <= half) return -3 * (offset / half) ** 2;
	if (offset >= 180) return -back;
	const t = (offset - half) / (180 - half);
	return -3 - (back - 3) * t * t * (3 - 2 * t);
}

/**
 * The horizontal cut's loss for one ray, in dB, positive to be added — the same
 * contract as `antennaLossDb`, and for the same reason.
 */
export function azimuthLossDb(bearing: number, profile: AntennaProfile): number {
	const gain = azimuthGainDb(bearing, profile);
	// `=== 0` rather than a bare negation, which would hand back −0 where there is no
	// horizontal cut at all.
	return gain === 0 ? 0 : -gain;
}

/**
 * Both cuts for one ray, as the single number a path's loss is built from.
 *
 * There is deliberately no way to apply the vertical cut alone to a profile that has
 * a horizontal one: the two are added here, from the ray's own `dx`/`dy`, so a call
 * site cannot forget the second term and quietly give a wall-mounted unit a back
 * lobe as strong as its front. Both callers and the tests go through this.
 */
export function antennaRayLossDb(
	profile: AntennaProfile,
	vertical: number,
	dx: number,
	dy: number
): number {
	return (
		antennaLossDb(profile, vertical, Math.hypot(dx, dy)) +
		azimuthLossDb(bearingDeg(dx, dy), profile)
	);
}

/**
 * A short identity for everything about an access point that changes its *pattern*.
 *
 * Cache keys are this codebase's most repeated source of stale-picture bugs: a key that
 * forgets one of these fields hands back a picture built for a different antenna, and
 * the symptom is a heatmap, a tile or a coverage figure that disagrees with the panel.
 * Every key that covers an antenna builds that part by calling this — one list of
 * fields, three call sites, instead of three hand-written fragments that drift apart.
 */
export function antennaSignature(ap: {
	beamwidthDeg?: number | null;
	aimDeg?: number | null;
	mount?: string | null;
	facingDeg?: number | null;
}): string {
	return `${ap.beamwidthDeg ?? 0}/${ap.aimDeg ?? 0}/${ap.mount ?? ''}/${ap.facingDeg ?? 0}`;
}
