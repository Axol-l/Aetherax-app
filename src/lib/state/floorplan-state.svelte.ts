export const floorplanState = $state({
	floorplanUrl: null as string | null,
	floorplanScale: 0.4,
	calibration: null as { worldUnitsPerMeter: number } | null,
	floorplanBoundary: null as Array<{ x: number; y: number }> | null,
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
