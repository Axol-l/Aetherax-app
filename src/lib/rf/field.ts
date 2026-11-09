/**
 * 复数场的基础运算。
 *
 * 用于把路径从“功率相加”升级成“复振幅相加”：每条路径保留幅度和相位，
 * 在接收点按极化分量求和后再取功率。
 */

export interface Complex {
	re: number;
	im: number;
}

export const complex = (re: number, im = 0): Complex => ({ re, im });

export function cAdd(a: Complex, b: Complex): Complex {
	return { re: a.re + b.re, im: a.im + b.im };
}

export function cMul(a: Complex, b: Complex): Complex {
	return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

export function cScale(a: Complex, s: number): Complex {
	return { re: a.re * s, im: a.im * s };
}

/** 功率（线性）转复振幅，相位单位为弧度。 */
export function cFromPower(power: number, phase = 0): Complex {
	const amplitude = Math.sqrt(Math.max(0, power));
	return { re: amplitude * Math.cos(phase), im: amplitude * Math.sin(phase) };
}

/** 复振幅的功率。 */
export function cPower(a: Complex): number {
	return a.re * a.re + a.im * a.im;
}

/** 自由空间相位：`-k d`，`distanceM` 为米。 */
export function pathPhase(distanceM: number, frequencyHz: number): number {
	const c = 299_792_458;
	return (-2 * Math.PI * frequencyHz * distanceM) / c;
}

/** 两个线极化分量。 */
export interface PolarizedField {
	vertical: Complex;
	horizontal: Complex;
}

export const emptyPolarized = (): PolarizedField => ({
	vertical: { re: 0, im: 0 },
	horizontal: { re: 0, im: 0 }
});

/** 2×2 Jones 矩阵；行是输出 V/H，列是输入 V/H。 */
export interface JonesMatrix {
	vv: Complex;
	vh: Complex;
	hv: Complex;
	hh: Complex;
}

export function diagonalJones(vv: Complex, hh: Complex): JonesMatrix {
	return { vv, vh: { re: 0, im: 0 }, hv: { re: 0, im: 0 }, hh };
}

/** 线极化输入向量。0 为垂直，π/2 为水平。 */
export function polarizationVector(angle: number): PolarizedField {
	return {
		vertical: { re: Math.cos(angle), im: 0 },
		horizontal: { re: Math.sin(angle), im: 0 }
	};
}

/** 用 Jones 矩阵作用到入射极化场。 */
export function applyJones(matrix: JonesMatrix, input: PolarizedField): PolarizedField {
	return {
		vertical: cAdd(cMul(matrix.vv, input.vertical), cMul(matrix.vh, input.horizontal)),
		horizontal: cAdd(cMul(matrix.hv, input.vertical), cMul(matrix.hh, input.horizontal))
	};
}

/**
 * 逐点 SINR，dB。输入都是线性功率，噪声以 dBm 给出。
 * 没有信号时返回 -Infinity。
 */
export function sinrDb(signalMw: number, interferenceMw: number, noiseDbm: number): number {
	if (!(signalMw > 0)) return -Infinity;
	const noiseMw = 10 ** (noiseDbm / 10);
	return 10 * Math.log10(signalMw / (noiseMw + Math.max(0, interferenceMw)));
}
