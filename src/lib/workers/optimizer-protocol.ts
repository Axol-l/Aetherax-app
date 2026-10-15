/**
 * What the main thread and the optimiser worker agree to send each other.
 *
 * The payload used to be declared twice — once in the worker, once implicitly by the
 * object literals the caller built — with every antenna field *optional*. That is a
 * payload that typechecks while saying nothing: forgetting `mount` or `facingDeg` was
 * not an error, it just meant "an upright omni", and the optimiser then scored a
 * different antenna from the one the panel showed. The bug class is the shape of the
 * declaration, so the declaration is derived from the state instead of restated.
 *
 * `ApInput` is therefore built from `AccessPoint`: add a field to the list below and
 * every construction site fails to compile until it supplies it, and change a field's
 * type on `AccessPoint` and this follows automatically. The type is erased at build
 * time, so importing it costs the worker nothing at run time.
 */
import type { AccessPoint } from '../state/ap-state.svelte.js';

/**
 * Bumped when the payload's *meaning* changes, not when a field is added.
 *
 * The worker is a bundled asset and the main thread is the app around it, so during
 * development a cached worker can outlive the code that calls it. A mismatch is then
 * loud (`assertApPayload`) rather than a silently different model.
 */
export const OPTIMIZER_PAYLOAD_VERSION = 2;

/**
 * The state fields the search has to be told about.
 *
 * Everything here is a *model input*: geometry (`x`, `y`), the reach it implies
 * (`interferenceRadius`, `band`, `channelWidth`), the channels it may be given
 * (`assignedChannel`, `fixedChannel`) and the antenna (`beamwidthDeg`, `aimDeg`,
 * `mount`, `facingDeg`). Anything the worker does not read does not belong here — the
 * point of the list is that it is short enough to check by eye.
 */
type ApPayloadField =
	| 'id'
	| 'x'
	| 'y'
	| 'interferenceRadius'
	| 'band'
	| 'channelWidth'
	| 'assignedChannel'
	| 'fixedChannel'
	| 'beamwidthDeg'
	| 'aimDeg'
	| 'mount'
	| 'facingDeg';

/**
 * One placed access point, as the worker sees it.
 *
 * `verticalGap` is the one field the state does not hold, because it is geometry the
 * worker has no floors to derive: the caller measures it (see `apVerticalOffsetTo`).
 * It is required here for the same reason as the rest — a missing vertical term is a
 * different path loss, not a default.
 */
export type ApInput = { [K in ApPayloadField]: AccessPoint[K] } & {
	/** Vertical distance from this AP to the client, in world units. 0 is a flat path. */
	verticalGap: number;
};

/** The fields a caller must have filled in before a run may start. */
const REQUIRED_AP_FIELDS = [
	'id',
	'x',
	'y',
	'interferenceRadius',
	'band',
	'channelWidth',
	'assignedChannel',
	'fixedChannel',
	'beamwidthDeg',
	'aimDeg',
	'mount',
	'facingDeg',
	'verticalGap'
] as const;

/**
 * Fail loudly on a payload that is missing something the model reads.
 *
 * Only reachable if a caller bypasses the type — a stale cached worker bundle during
 * development, or a hand-built message in a test. It exists because the alternative is
 * the failure this module was written to prevent: `undefined` quietly becoming "no
 * antenna cut", and a scored layout that no longer matches the one on screen.
 */
export function assertApPayload(aps: ReadonlyArray<Record<string, unknown>>): void {
	for (const [index, ap] of aps.entries()) {
		for (const field of REQUIRED_AP_FIELDS) {
			if (ap[field] === undefined) {
				throw new Error(
					`optimiser payload ${OPTIMIZER_PAYLOAD_VERSION}: AP ${index} is missing "${field}"`
				);
			}
		}
	}
}
