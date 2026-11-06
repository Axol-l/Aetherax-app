/**
 * 材质损耗的物理模型，采用 ITU-R P.2040-3 §2.1.4 的单层平板方程（f 单位 GHz，σ 单位 S/m）：
 *
 *   εr = a · f^b        σ = c · f^d
 *   η  = εr − j σ / (2π f ε₀)
 *   q  = (2π d / λ) √(η − sin²θ)
 *   r⊥ = (cosθ − √(η−sin²θ)) / (cosθ + √(η−sin²θ))        （平行极化同理）
 *   R  = r(1 − e^{−2jq}) / (1 − r² e^{−2jq})
 *   T  = (1 − r²) e^{−jq} / (1 − r² e^{−2jq})
 *
 * 一次穿越的损耗取两种极化 dB 的均值；入射角固定为正入射。
 */

/** ITU-R P.2040-3 表 3：`(minGHz, maxGHz) → (a, b, c, d)`。 */
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
 * 单次穿越损耗的上限，dB。
 *
 * 金属的 `|T|` 为零即 −∞ dB，这里按不透明处理，避免热力图与优化器遇到无穷值。
 */
export const MAX_MATERIAL_LOSS_DB = 60;

// ─── 复数运算 ──────────────────────────────────────────────────────
// 只做必要运算：每次穿越计算四个系数，不做场求解。

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

/** P.2040 材质在某频率下的 εr 与 σ，频率单位 GHz。 */
export function ituEpsilon(
	key: ItuMaterialKey,
	frequencyGhz: number
): { epsR: number; sigma: number } {
	const rows = ITU_TABLE[key] as ReadonlyArray<readonly [number, number, number, number, number, number]>;
	// 取覆盖该频率的首行；频率落在所有区间之外时退回首行。
	const covering = rows.find((row) => frequencyGhz >= row[0] && frequencyGhz <= row[1]) ?? rows[0]!;
	const [, , a, b, c, d] = covering;
	return {
		epsR: a * Math.pow(frequencyGhz, b),
		sigma: c * Math.pow(frequencyGhz, d)
	};
}

export interface SlabCoefficients {
	/** 反射系数，垂直（TE）与平行（TM）极化。 */
	rTe: Complex;
	rTm: Complex;
	/** 透射系数，垂直（TE）与平行（TM）极化。 */
	tTe: Complex;
	tTm: Complex;
}

/**
 * 单层平板的反射与透射系数（P.2040 式 43–44），从真空侧入射。
 *
 * `cosTheta` 为入射角余弦（1 表示正入射），`thicknessM` 为板厚，单位米。
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
 * 一次正入射穿越的损耗，dB，取两种极化的均值。
 *
 * 结果钳制在 `[0, MAX_MATERIAL_LOSS_DB]`；板厚不为正时返回 0。
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

/** 各频段材质损耗取值所用的中心频率，单位 GHz。 */
export const BAND_FREQUENCY_GHZ = {
	'2.4ghz': 2.447,
	'5ghz': 5.5,
	'6ghz': 6.53
} as const;

/** 给定厚度下，ITU 材质在某频段一次穿越的损耗。 */
export function ituWallLossDb(
	key: ItuMaterialKey,
	frequencyGhz: number,
	thicknessM: number,
	cosTheta = 1
): number {
	const { epsR, sigma } = ituEpsilon(key, frequencyGhz);
	return slabLossDb(epsR, sigma, frequencyGhz, thicknessM, cosTheta);
}
