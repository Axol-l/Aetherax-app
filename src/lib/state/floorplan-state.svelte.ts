import { currentFloor, type Floor } from './floor-state.svelte.js';

/**
 * The session-only underlay state: things about the last import that are not part of the
 * plan itself.
 */
const session = $state({
	unitSystem: 'imperial' as 'imperial' | 'metric',
	/**
	 * What kind of file the underlay came from.
	 *
	 * Needed because the underlay is a session blob URL: by the time Re-detect Walls
	 * runs there is nothing left in the URL that says whether the plan is a vector
	 * drawing or a photograph of one, and the two want different detectors. Set when
	 * the plan is imported, and by `loadSample` for the bundled SVG samples.
	 */
	sourceIsVector: false,
	/**
	 * Why the last import did not become a floorplan, or null.
	 *
	 * Set when a dropped file is a format this app cannot read. Both drop handlers used to
	 * `return` in silence, so dropping a PDF — the format a real floorplan most often
	 * arrives in — looked exactly like the app being broken.
	 */
	importNotice: null as string | null
});

/**
 * The current floor's underlay, read and written through the floor itself.
 *
 * The same change as `wall-state.ts`: these four fields used to be a mirror of `Floor`,
 * copied in both directions on every save, restore, floor switch, undo and import. A getter
 * and a setter per field removes the copy — and with it the class of bug where a floor
 * switch left the previous floor's underlay on screen.
 *
 * `unitSystem`, `sourceIsVector` and `importNotice` stay here because they describe the
 * project or the session, not a floor.
 */
export const floorplanState = {
	get floorplanUrl(): string | null {
		return currentFloor().floorplanUrl;
	},
	set floorplanUrl(url: string | null) {
		currentFloor().floorplanUrl = url;
	},

	get floorplanScale(): number {
		return currentFloor().floorplanScale;
	},
	set floorplanScale(scale: number) {
		currentFloor().floorplanScale = scale;
	},

	get calibration(): Floor['calibration'] {
		return currentFloor().calibration;
	},
	set calibration(calibration: Floor['calibration']) {
		currentFloor().calibration = calibration;
	},

	get floorplanBoundary(): Floor['floorplanBoundary'] {
		return currentFloor().floorplanBoundary;
	},
	set floorplanBoundary(boundary: Floor['floorplanBoundary']) {
		currentFloor().floorplanBoundary = boundary;
	},

	get unitSystem(): 'imperial' | 'metric' {
		return session.unitSystem;
	},
	set unitSystem(system: 'imperial' | 'metric') {
		session.unitSystem = system;
	},

	get sourceIsVector(): boolean {
		return session.sourceIsVector;
	},
	set sourceIsVector(isVector: boolean) {
		session.sourceIsVector = isVector;
	},

	get importNotice(): string | null {
		return session.importNotice;
	},
	set importNotice(notice: string | null) {
		session.importNotice = notice;
	}
};
