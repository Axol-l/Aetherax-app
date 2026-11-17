// 统一处理长度、面积和单位显示

export type UnitSystem = 'imperial' | 'metric';

/** A unit a *length* is shown in. */
export type LengthUnit = 'm' | 'ft';

/** A unit an *area* is shown in. */
export type AreaUnit = 'sqm' | 'sqft';

const FEET_PER_METRE = 3.280839895013123;
const SQM_PER_SQFT = 0.09290304;

/** Values at or above this are shown as whole numbers; below it, to one decimal. */
const WHOLE_NUMBER_FROM = 10;

/** The length unit a project's unit system displays. */
export function lengthUnit(system: UnitSystem): LengthUnit {
	return system === 'imperial' ? 'ft' : 'm';
}

/** The area unit a project's unit system displays. */
export function areaUnit(system: UnitSystem): AreaUnit {
	return system === 'imperial' ? 'sqft' : 'sqm';
}

/** Convert a length between display units.*/
export function convertLength(value: number, from: LengthUnit, to: LengthUnit): number {
	if (from === to) return value;
	return from === 'm' ? value * FEET_PER_METRE : value / FEET_PER_METRE;
}

/** Convert an area between display units. */
export function convertArea(value: number, from: AreaUnit, to: AreaUnit): number {
	if (from === to) return value;
	return from === 'sqm' ? value / SQM_PER_SQFT : value * SQM_PER_SQFT;
}

/** A length in metres, as the given display unit. */
export function metresToUnit(metres: number, unit: LengthUnit): number {
	return convertLength(metres, 'm', unit);
}

/** A length shown in `unit`, back in metres. */
export function unitToMetres(value: number, unit: LengthUnit): number {
	return convertLength(value, unit, 'm');
}

/** An area in square metres, as the given display unit. */
export function sqmToUnit(sqm: number, unit: AreaUnit): number {
	return convertArea(sqm, 'sqm', unit);
}

/** An area shown in `unit`, back in square metres. */
export function unitToSqm(value: number, unit: AreaUnit): number {
	return convertArea(value, unit, 'sqm');
}

/** How many decimals a figure is shown with.*/
export function displayDecimals(value: number): number {
	const magnitude = Math.abs(value);
	if (!Number.isFinite(magnitude)) return 0;
	return magnitude >= WHOLE_NUMBER_FROM ? 0 : 1;
}

/** A number rounded the way `displayDecimals` says, without trailing zeros. */
export function roundForDisplay(value: number): number {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** displayDecimals(value);
	return Math.round(value * factor) / factor;
}

/** A display value as text. */
export function formatNumber(value: number): string {
	return String(roundForDisplay(value));
}

/** A measurement with its unit. */
export function formatMeasure(value: number, unit: string): string {
	return `${formatNumber(value)} ${unit}`;
}

/**
 * A length in metres, ready to display: the rounded figure, its text form, and
 * the unit it is in.
 */
export function displayLength(
	metres: number,
	unit: LengthUnit
): { value: number; text: string; unit: LengthUnit } {
	const value = roundForDisplay(metresToUnit(metres, unit));
	return { value, text: String(value), unit };
}

/** An area in square metres, ready to display. */
export function displayArea(
	sqm: number,
	unit: AreaUnit
): { value: number; text: string; unit: AreaUnit } {
	const value = roundForDisplay(sqmToUnit(sqm, unit));
	return { value, text: String(value), unit };
}

/**
 * Spinner hints for a number input that stores metres but is typed in the
 * project's display unit.
 */
export function lengthInputHints(
	minMetres: number,
	maxMetres: number,
	stepMetres: number,
	unit: LengthUnit
): { min: number; max: number; step: number } {
	if (unit === 'm') return { min: minMetres, max: maxMetres, step: stepMetres };
	const round2 = (v: number) => Math.round(v * 100) / 100;
	return {
		min: round2(metresToUnit(minMetres, unit)),
		max: round2(metresToUnit(maxMetres, unit)),
		step: round2(metresToUnit(stepMetres, unit))
	};
}
