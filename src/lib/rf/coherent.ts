/**
 * 相干路径合成。
 *
 * 每条路径以一个复振幅进入接收点；极化用垂直/水平两个分量表示。
 * 这里不绑定具体几何，只负责“路径 → 复场 → 功率”。
 */
import {
	cAdd,
	cFromPower,
	cMul,
	cPower,
	cScale,
	type Complex,
	type PolarizedField
} from './field.js';

export interface CoherentPath {
	/** 线性功率，不含反射系数相位。 */
	power: number;
	/** 自由空间相位，弧度。 */
	phase: number;
	/** 复反射/绕射/散射系数；不传表示 1。 */
	coefficient?: Complex;
	/** 线极化角，0 为垂直，π/2 为水平。 */
	polarizationAngle?: number;
}

/** 将一条路径的功率、相位和极化角转成 V/H 复场。 */
export function pathField(path: CoherentPath): PolarizedField {
	const amplitude = Math.sqrt(Math.max(0, path.power));
	const angle = path.polarizationAngle ?? 0;
	const phase = path.phase;
	const coefficient = path.coefficient ?? { re: 1, im: 0 };
	const base = cFromPower(amplitude * amplitude, phase);
	const withCoefficient = cMul(base, coefficient);
	return {
		vertical: cScale(withCoefficient, Math.cos(angle)),
		horizontal: cScale(withCoefficient, Math.sin(angle))
	};
}

/** 把所有路径按 V/H 复场相加。 */
export function sumCoherent(paths: readonly CoherentPath[]): PolarizedField {
	let vertical: Complex = { re: 0, im: 0 };
	let horizontal: Complex = { re: 0, im: 0 };
	for (const path of paths) {
		const field = pathField(path);
		vertical = cAdd(vertical, field.vertical);
		horizontal = cAdd(horizontal, field.horizontal);
	}
	return { vertical, horizontal };
}

/** 复场总功率。 */
export function fieldPower(field: PolarizedField): number {
	return cPower(field.vertical) + cPower(field.horizontal);
}

/** 相干路径的接收功率。 */
export function coherentPower(paths: readonly CoherentPath[]): number {
	return fieldPower(sumCoherent(paths));
}
