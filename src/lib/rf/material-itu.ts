/**
 * Material loss from physics instead of a hand-tuned table.
 *
 * The app's wall materials used to carry one `dB per metre` figure per band, with 5 GHz as
 * the anchor and the other two bands scaled by hand (2.4 GHz × 1/1.9, 6 GHz × 1.2). That is a
 * table, not a model: it says a 1 cm glass pane loses more at 6 GHz than at 2.4 GHz (it does
 * not — thin glass is nearly transparent at 6 GHz), and it puts a 20 cm concrete wall at
 * 6.4 dB when P.2040 puts it above 14.
 *
 * This module implements the model the numbers come from — ITU-R P.2040-3 §2.1.4 (the same
 * table and the same single-layer-slab equations Sionna RT solves for transmission, see its
 * `radio_materials/itu.py` and `utils/electromagnetics.py`):
 *
 *   εr = a · f^b        σ = c · f^d        (f in GHz, σ in S/m)
 *   η  = εr − j σ / (2π f ε₀)
 *   q  = (2π d / λ) √(η − sin²θ)
 *   r⊥ = (cosθ − √(η−sin²θ)) / (cosθ + √(η−sin²θ))        (and the parallel form)
 *   R  = r(1 − e^{−2jq}) / (1 − r² e^{−2jq})
 *   T  = (1 − r²) e^{−jq} / (1 − r² e^{−2jq})
 *
 * and takes the loss of a crossing as `−10·log10(|T⊥|² + |T∥|²)/2` — i.e. the mean of the two
 * polarisations in dB. The app's model is a power sum, not a coherent field, so a single
 * figure per crossing is exactly the shape it needs.
 *
 * **What this does not do:** the incidence angle is not known per crossing yet (that arrives
 * with reflection, which needs the same four coefficients), so every call here is normal
 * incidence. `slabTransmission` already takes `cosTheta`, so the day the march knows the angle
 * it is a parameter change rather than a rewrite.
 */

/** ITU-R P.2040-3, Table 3: `(minGHz, maxGHz) → (a, b, c, d)`. */
const ITU_TABLE = {
	plasterboard: [
		[1, 100, 2.73, 0, 0.0085, 0.9395],
		[100, 400, 2.65, 0, 0.0002, 1.598]
	],
	wood: [
		[0.001, 100, 1.99, 0, 0.0047, 1.0718],
		[100, 400, 2.1183, 0, 0.0055, 1.1113]
	],
	glass: [
		[0.1, 100, 6.31, 0, 0.0036, 1.3394],
		[100, 400, 6.5767, 0, 0.0012, 1.4697]
	],
	brick: [
		[1, 40, 3.91, 0, 0.0238, 0.16],
		[110, 330, 4.15, 0, 0.0006, 1.5712]
	],
	concrete: [
		[1, 100, 5.24, 0, 0.0462, 0.7822],
		[110, 330, 5.17, 0, 0.0145, 1.09]
	],
	metal: [[1, 100, 1.0, 0, 1e7, 0]]
} as const;

export type ItuMaterialKey = keyof typeof ITU_TABLE;

const SPEED_OF_LIGHT = 299_792_458;
const EPSILON_0 = 8.854_187_812_8e-12;

/**
 * The loss is clamped here.
 *
 * A perfect conductor makes `|T|` zero, which is −∞ dB. The model charges a crossing as a
 * number, so metal has to be *opaque* rather than infinite: 60 dB is more than any receiver's
 * dynamic range indoors, and it keeps the heatmap and the optimiser away from infinities.
 */
export const MAX_MATERIAL_LOSS_DB = 60;

// ─── Complex arithmetic ────────────────────────────────────────────
// Minimal on purpose: four coefficients per crossing, not a field solver.

interface Complex {
	re: number;
	im: number;
}

const cx = (re: number, im = 0): Complex => ({ re, im });
const add = (a: Complex, b: Complex): Complex => cx(a.re + b.re, a.im + b.im);
const sub = (a: Complex, b: Complex): Complex => cx(a.re - b.re, a.im - b.im);
const mul = (a: Complex, b: Complex): Complex =>
	cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a: Complex, b: Complex): Complex => {
	const d = b.re * b.re + b.im * b.im;
	if (d === 0) return cx(0, 0);
	return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const sqrtc = (a: Complex): Complex => {
	const r = Math.hypot(a.re, a.im);
	const re = Math.sqrt(Math.max(0, (r + a.re) / 2));
	const im = Math.sign(a.im) * Math.sqrt(Math.max(0, (r - a.re) / 2));
	return cx(re, im);
};
const expc = (a: Complex): Complex => {
	const e = Math.exp(a.re);
	return cx(e * Math.cos(a.im), e * Math.sin(a.im));
};
const absSq = (a: Complex): number => a.re * a.re + a.im * a.im;

/** εr and σ of a P.2040 material at a frequency in GHz. */
export function ituEpsilon(
	key: ItuMaterialKey,
	frequencyGhz: number
): { epsR: number; sigma: number } {
	const rows = ITU_TABLE[key] as ReadonlyArray<readonly [number, number, number, number, number, number]>;
	// The first row that covers the frequency; a frequency outside every range uses the
	// nearest row, because a band whose edges sit between two ranges still needs an answer.
	const covering = rows.find((row) => frequencyGhz >= row[0] && frequencyGhz <= row[1]) ?? rows[0]!;
	const [, , a, b, c, d] = covering;
	return {
		epsR: a * Math.pow(frequencyGhz, b),
		sigma: c * Math.pow(frequencyGhz, d)
	};
}

export interface SlabCoefficients {
	/** Reflection, perpendicular (TE) and parallel (TM) polarisation. */
	rTe: Complex;
	rTm: Complex;
	/** Transmission, perpendicular (TE) and parallel (TM) polarisation. */
	tTe: Complex;
	tTm: Complex;
}

/**
 * Single-layer slab coefficients (P.2040 eqs. 43–44), incidence from vacuum.
 *
 * `cosTheta` is the cosine of the incidence angle (1 = normal); `thicknessM` the slab's
 * thickness in metres and `frequencyGhz` the frequency.
 */
export function slabTransmission(
	epsR: number,
	sigma: number,
	frequencyGhz: number,
	thicknessM: number,
	cosTheta = 1
): SlabCoefficients {
	const fHz = frequencyGhz * 1e9;
	const omega = 2 * Math.PI * fHz;
	const wavelength = SPEED_OF_LIGHT / fHz;
	const eta = cx(epsR, -sigma / (omega * EPSILON_0));
	const cos = Math.min(1, Math.max(1e-6, cosTheta));
	const sinSq = 1 - cos * cos;
	const root = sqrtc(sub(eta, cx(sinSq)));
	// q = (2πd/λ)·√(η − sin²θ)
	const q = mul(cx((2 * Math.PI * thicknessM) / wavelength), root);

	const rTe = div(sub(cx(cos), root), add(cx(cos), root));
	const rTm = div(sub(mul(eta, cx(cos)), root), add(mul(eta, cx(cos)), root));

	const expMinusJq = expc(mul(cx(0, -1), q));
	const expMinus2Jq = mul(expMinusJq, expMinusJq);

	const rTe2 = mul(rTe, rTe);
	const rTm2 = mul(rTm, rTm);
	const denTe = sub(cx(1), mul(rTe2, expMinus2Jq));
	const denTm = sub(cx(1), mul(rTm2, expMinus2Jq));

	return {
		rTe: div(mul(rTe, sub(cx(1), expMinus2Jq)), denTe),
		rTm: div(mul(rTm, sub(cx(1), expMinus2Jq)), denTm),
		tTe: div(mul(sub(cx(1), rTe2), expMinusJq), denTe),
		tTm: div(mul(sub(cx(1), rTm2), expMinusJq), denTm)
	};
}

/**
 * Loss of one normal-incidence crossing, in dB: the mean of the two polarisations.
 *
 * Clamped to `[0, MAX_MATERIAL_LOSS_DB]` — a slab cannot amplify, and metal is opaque rather
 * than infinite.
 */
export function slabLossDb(
	epsR: number,
	sigma: number,
	frequencyGhz: number,
	thicknessM: number,
	cosTheta = 1
): number {
	if (thicknessM <= 0) return 0;
	const { tTe, tTm } = slabTransmission(epsR, sigma, frequencyGhz, thicknessM, cosTheta);
	const power = (absSq(tTe) + absSq(tTm)) / 2;
	if (!(power > 0)) return MAX_MATERIAL_LOSS_DB;
	const db = -10 * Math.log10(power);
	return Math.min(MAX_MATERIAL_LOSS_DB, Math.max(0, db));
}

/** The band centre a material figure is evaluated at, in GHz. */
export const BAND_FREQUENCY_GHZ = {
	'2.4ghz': 2.447,
	'5ghz': 5.5,
	'6ghz': 6.53
} as const;

/** Loss of one crossing of an ITU material at a band, for a given thickness. */
export function ituWallLossDb(
	key: ItuMaterialKey,
	frequencyGhz: number,
	thicknessM: number,
	cosTheta = 1
): number {
	const { epsR, sigma } = ituEpsilon(key, frequencyGhz);
	return slabLossDb(epsR, sigma, frequencyGhz, thicknessM, cosTheta);
}
