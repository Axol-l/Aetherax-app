/**
 * The vertical antenna cut: its anchors, its monotonicity, and the fit to the
 * vendor measurements it was calibrated from.
 *
 * The anchors are the three things a reader can check against a datasheet or one
 * of the `.ant` files: 0 dB on the peak, −3 dB at the half-power angle, and the
 * broadside floor. The last two tests pin the *numbers* rather than the shape,
 * because the shape was fitted to the local Ubiquiti cuts
 * (`docs/PHYSICAL_MODELS.md` D2) and a change that quietly doubles the near-field
 * loss would otherwise pass everything here.
 */
import { describe, expect, it } from 'vitest';
import {
	angleBelowHorizonDeg,
	antennaFloorDb,
	antennaLossDb,
	antennaRayLossDb,
	azimuthGainDb,
	azimuthLossDb,
	bearingDeg,
	defaultAntenna,
	elevationGainDb,
	WALL_MOUNT_AZIMUTH,
	wrap180,
	type AntennaProfile
} from './antenna.js';

const omni5 = defaultAntenna(null, '5ghz');
const omni24 = defaultAntenna(null, '2.4ghz');

describe('elevationGainDb', () => {
	it('is 0 dB on the peak and −3 dB at the half-power angle', () => {
		expect(elevationGainDb(0, omni5)).toBeCloseTo(0, 10);
		expect(elevationGainDb(30, omni5)).toBeCloseTo(-3, 10);
		// The 2.4 GHz default is twice as wide, so −3 dB arrives twice as far out.
		expect(elevationGainDb(0, omni24)).toBeCloseTo(0, 10);
		expect(elevationGainDb(60, omni24)).toBeCloseTo(-3, 10);
	});

	it('reaches the broadside floor at 90° and stays there', () => {
		expect(elevationGainDb(90, omni5)).toBeCloseTo(-12, 10);
		expect(elevationGainDb(120, omni5)).toBeCloseTo(-12, 10);
		expect(elevationGainDb(-180, omni5)).toBeCloseTo(-12, 10);
	});

	it('never increases with the angle off the peak', () => {
		for (const beamwidth of [30, 60, 90, 120, 179]) {
			const profile: AntennaProfile = { beamwidthDeg: beamwidth, aimDeg: 0, floorDb: 12 };
			let previous = Infinity;
			// Swept as an offset, not as an angle: the pattern is symmetric, so a
			// sweep from −180° to 180° walks back up towards the peak again.
			for (let offset = 0; offset <= 180; offset += 1) {
				const gain = elevationGainDb(offset, profile);
				expect(gain).toBeLessThanOrEqual(previous + 1e-9);
				previous = gain;
			}
		}
	});

	it('is flat at 180°, which is how "no pattern" is expressed', () => {
		const flat: AntennaProfile = { beamwidthDeg: 180, aimDeg: 0, floorDb: 12 };
		for (const angle of [0, 45, 90, 135, 180]) {
			expect(elevationGainDb(angle, flat)).toBeCloseTo(0, 10);
		}
		// Which is what reproduces the model before this module: a level ray and one
		// straight down are given the same treatment.
		expect(elevationGainDb(90, flat)).toBe(elevationGainDb(0, flat));
	});

	it('is symmetric about the horizon without aim, and not with it', () => {
		expect(elevationGainDb(40, omni5)).toBeCloseTo(elevationGainDb(-40, omni5), 10);
		const tilted: AntennaProfile = { ...omni5, aimDeg: 20 };
		// Tilted down, the peak is 20° below the horizon: a ray going down 20° is on
		// it, one going *up* 20° is 40° off it — as far off as a 60° ray downwards.
		expect(elevationGainDb(20, tilted)).toBeCloseTo(0, 10);
		expect(elevationGainDb(-20, tilted)).toBeLessThan(elevationGainDb(20, tilted));
		expect(elevationGainDb(-20, tilted)).toBeCloseTo(elevationGainDb(60, tilted), 10);
	});

	it('matches the measured vendor cuts within a decibel where a client sits', () => {
		/*
		 * A same-floor client at 2 m / 1 m / 0.5 m, at the default ceiling preset on a
		 * 3 m storey, is 35° / 54° / 70° below the horizon. The measured 5 GHz cuts of
		 * the three local models read 2–7, 4–8 and 5–10 dB down at those angles; the
		 * default profile has to land inside those bands, near their middle.
		 */
		const at = (deg: number) => -elevationGainDb(deg, omni5);
		expect(at(35)).toBeGreaterThan(2);
		expect(at(35)).toBeLessThan(7);
		expect(at(54)).toBeGreaterThan(4);
		expect(at(54)).toBeLessThan(8);
		expect(at(70)).toBeGreaterThan(5);
		expect(at(70)).toBeLessThan(10);
		// And the near field must stay worse than the far field, or the profile is
		// doing nothing: 20 m is 4° below the horizon.
		expect(at(4)).toBeLessThan(1);
		expect(at(70)).toBeGreaterThan(at(4) + 4);
	});
});

describe('defaultAntenna', () => {
	it('is a level doughnut with the band’s own width', () => {
		expect(omni5).toEqual({ beamwidthDeg: 60, aimDeg: 0, floorDb: 12 });
		expect(omni24.beamwidthDeg).toBe(120);
		expect(omni24.aimDeg).toBe(0);
	});

	it('falls back to 5 GHz for a band it has no measurement for', () => {
		expect(defaultAntenna(null, 'unknown').beamwidthDeg).toBe(60);
		expect(antennaFloorDb('unknown')).toBe(12);
		expect(antennaFloorDb('2.4ghz')).toBe(7);
	});
});

describe('angleBelowHorizonDeg', () => {
	it('is 0 for a level ray, 90 straight down and negative above', () => {
		expect(angleBelowHorizonDeg(0, 10)).toBeCloseTo(0, 10);
		expect(angleBelowHorizonDeg(1.4, 0)).toBeCloseTo(90, 10);
		expect(angleBelowHorizonDeg(-1.4, 0)).toBeCloseTo(-90, 10);
	});

	it('matches the geometry of a ceiling access point', () => {
		// 1.4 m below the AP and 2 m out: 35°.
		expect(angleBelowHorizonDeg(1.4, 2)).toBeCloseTo(35, 0);
		// The same 1.4 m with the client 20 m away is nearly level.
		expect(angleBelowHorizonDeg(1.4, 20)).toBeCloseTo(4, 0);
	});
});

describe('antennaLossDb', () => {
	/**
	 * The sign, pinned at the level the callers use it at.
	 *
	 * `elevationGainDb` is negative for every direction but the peak, so a caller
	 * that subtracts it *adds* signal, and the heatmap did exactly that: a narrower
	 * beam painted a larger covered area. A test of the gain curve alone cannot see
	 * that, which is why this one exists and is stated as a loss.
	 */
	it('is a positive loss, never a gain', () => {
		for (const angle of [0, 10, 35, 54, 70, 90, 120]) {
			const vertical = Math.sin((angle * Math.PI) / 180);
			const horizontal = Math.cos((angle * Math.PI) / 180);
			expect(antennaLossDb(omni5, vertical, horizontal)).toBeGreaterThanOrEqual(0);
		}
	});

	it('grows as the ray gets steeper, and as the beam gets narrower', () => {
		// 1.4 m of height against 20 m / 2 m / 0.5 m of floor: 4° / 35° / 70°.
		const shallow = antennaLossDb(omni5, 1.4, 20);
		const middle = antennaLossDb(omni5, 1.4, 2);
		const steep = antennaLossDb(omni5, 1.4, 0.5);
		expect(shallow).toBeLessThan(middle);
		expect(middle).toBeLessThan(steep);
		// Narrower beam, same ray: strictly more loss in the near field.
		const narrow = antennaLossDb({ ...omni5, beamwidthDeg: 30 }, 1.4, 0.5);
		expect(narrow).toBeGreaterThan(steep);
		// A flat profile costs nothing anywhere — the model before this module.
		expect(antennaLossDb({ ...omni5, beamwidthDeg: 180 }, 1.4, 0.25)).toBeCloseTo(0, 10);
	});
});

describe('the wall mount’s horizontal cut', () => {
	/** A wall-mounted unit: the band's vertical cut plus the assumed horizontal one. */
	const wall = (facingDeg: number): AntennaProfile => ({
		...defaultAntenna(null, '5ghz'),
		facingDeg,
		...WALL_MOUNT_AZIMUTH
	});

	it('is absent unless the profile says the hardware has one', () => {
		// Every ceiling mount, and every profile written before wall mounts existed.
		for (const bearing of [0, 45, 90, 180, -135]) {
			expect(azimuthGainDb(bearing, omni5)).toBe(0);
			expect(azimuthLossDb(bearing, omni5)).toBe(0);
			// A 180° horizontal cut is the documented way to say "none at all".
			expect(azimuthGainDb(bearing, { ...omni5, azBeamwidthDeg: 180 })).toBe(0);
		}
	});

	it('is 0 dB straight ahead, −3 dB at the half-power angle and the floor behind', () => {
		const profile = wall(0);
		const half = WALL_MOUNT_AZIMUTH.azBeamwidthDeg / 2;
		expect(azimuthGainDb(0, profile)).toBeCloseTo(0, 10);
		expect(azimuthGainDb(half, profile)).toBeCloseTo(-3, 10);
		expect(azimuthGainDb(-half, profile)).toBeCloseTo(-3, 10);
		expect(azimuthGainDb(180, profile)).toBeCloseTo(-WALL_MOUNT_AZIMUTH.frontToBackDb, 10);
		expect(azimuthGainDb(-180, profile)).toBeCloseTo(-WALL_MOUNT_AZIMUTH.frontToBackDb, 10);
	});

	it('never rises as the bearing turns away from the facing direction', () => {
		const profile = wall(0);
		const samples = [0, 15, 30, 45, 60, 90, 120, 150, 179].map((b) => azimuthGainDb(b, profile));
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
		}
		expect(samples[samples.length - 1]!).toBeLessThan(samples[0]! - 15);
	});

	it('turns with the facing direction', () => {
		const profile = wall(90);
		// Facing +y (atan2's 90°), so straight ahead is 90° and straight behind is −90°.
		expect(azimuthGainDb(90, profile)).toBeCloseTo(0, 10);
		expect(azimuthGainDb(-90, profile)).toBeCloseTo(-WALL_MOUNT_AZIMUTH.frontToBackDb, 10);
		// And the same direction read as a different angle: 450° is 90°.
		expect(azimuthGainDb(450, profile)).toBeCloseTo(0, 10);
	});

	it('leaves the vertical cut alone, and only the azimuth term changes the ray', () => {
		// Same 3D geometry, opposite plan directions: identical distance and elevation,
		// and the difference is entirely the wall mount's back lobe.
		const profile = wall(0);
		const front = antennaRayLossDb(profile, 1.4, 2, 0);
		const back = antennaRayLossDb(profile, 1.4, -2, 0);
		expect(front).toBeCloseTo(antennaLossDb(profile, 1.4, 2), 10);
		expect(back - front).toBeCloseTo(WALL_MOUNT_AZIMUTH.frontToBackDb, 6);
		// A ceiling omni has no preferred direction: the two are the same ray.
		expect(antennaRayLossDb(omni5, 1.4, -2, 0)).toBeCloseTo(antennaRayLossDb(omni5, 1.4, 2, 0), 10);
	});
});

describe('wrap180 / bearingDeg', () => {
	it('folds any angle into (−180, 180]', () => {
		expect(wrap180(0)).toBe(0);
		expect(wrap180(350)).toBeCloseTo(-10, 10);
		expect(wrap180(-350)).toBeCloseTo(10, 10);
		expect(wrap180(180)).toBe(180);
		expect(wrap180(540)).toBe(180);
	});

	it('reads the plan bearing of a ray the way atan2 does', () => {
		expect(bearingDeg(1, 0)).toBeCloseTo(0, 10);
		expect(bearingDeg(0, 1)).toBeCloseTo(90, 10);
		expect(bearingDeg(-1, 0)).toBeCloseTo(180, 10);
		expect(bearingDeg(0, -1)).toBeCloseTo(-90, 10);
	});
});
