/**
 * Unit display for the interface.
 *
 * **Everything the application stores is metric**: ceiling heights and floor
 * thicknesses in metres, areas in square metres, lengths in world units derived
 * from a metres-per-world-unit scale. The toolbar's ft/m button switches what
 * the *interface* shows and nothing else.
 *
 * That switch used to reach only the few readouts that happened to consult
 * `unitSystem` themselves, which is how the sidebar ended up mixing feet and
 * metres; worse, the floorplan area field carried its own sqm/sqft toggle, so
 * two controls could disagree about the units of the same project. This module
 * is the single place that turns a stored metric value into a display value and
 * back, so one button cannot leave half a column converted.
 *
 * Rounding: converted values are rounded rather than printed to full float
 * precision (an area of 200 m² is 2152.782… sqft, which is noise, not
 * information). The rule is "whole numbers once the figure is large enough to
 * read as one, one decimal below that" — a 0.2 m floor slab is 0.7 ft and a
 * 0.1 m alignment offset is 0.3 ft, where rounding those to 1 ft and 0 ft would
 * destroy the value outright. See `roundForDisplay`.
 */

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

/**
 * Convert a length between display units.
 *
 * Both directions through one function: a length is a length, and having
 * `sqftToSqm`-style pairs for lengths as well as areas is how the two get
 * mixed up at a call site.
 */
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

/**
 * How many decimals a figure is shown with.
 *
 * Whole numbers from `WHOLE_NUMBER_FROM` up, one decimal below it. The
 * threshold is applied to the *display* value, so it reads the same way in both
 * unit systems: 3 m of ceiling is 3.0 m and 9.8 ft, 0.2 m of slab is 0.2 m and
 * 0.7 ft.
 */
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

/**
 * A display value as text: `49`, `8.2`, `0.7`.
 *
 * `String(roundForDisplay(v))` rather than `toFixed`, so a whole number has no
 * decimal point — these strings are also the `value` of number inputs, and
 * `8.0` in a number field reads as an edit the user did not make.
 */
export function formatNumber(value: number): string {
	return String(roundForDisplay(value));
}

/**
 * A measurement with its unit: `49 ft`, `2153 sqft`.
 *
 * `unit` is a bare unit name, not an i18n key: the symbols are the same in both
 * catalogues, which is also why the store keeps them rather than translating
 * them.
 */
export function formatMeasure(value: number, unit: string): string {
	return `${formatNumber(value)} ${unit}`;
}

/**
 * A length in metres, ready to display: the rounded figure, its text form, and
 * the unit it is in.
 *
 * One call rather than three so a call site cannot round in one place, label in
 * another and convert in a third — the three-way disagreement that put feet in
 * one sidebar row and metres in the next.
 */
export function displayLength(
	metres: number,
	unit: LengthUnit
): { value: number; text: string; unit: LengthUnit } {
	const value = roundForDisplay(metresToUnit(metres, unit));
	return { value, text: String(value), unit };
}

/** An area in square metres, ready to display. See `displayLength`. */
export function displayArea(
	sqm: number,
	unit: AreaUnit
): { value: number; text: string; unit: AreaUnit } {
	const value = roundForDisplay(sqmToUnit(sqm, unit));
	return { value, text: String(value), unit };
}

/**
 * Spinner hints for a number input that *stores* metres but is *typed* in the
 * project's display unit.
 *
 * The bounds are real bounds in the model (a ceiling is 2–10 m), so they have to
 * convert with the field; the step converts too, which is why a 0.5 m ceiling
 * step reads as 1.6 ft. Rounded to two decimals rather than through
 * `roundForDisplay`, because a step of "2 ft" for a 0.5 m increment would make
 * the arrows lie about how much they move the value.
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
