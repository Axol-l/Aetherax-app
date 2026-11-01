/**
 * The plan a worker has been sent, held until it is sent another one.
 *
 * A run's payload is mostly geometry — a wall mask, a material mask, the room types, the
 * density map and every cross-floor source mask, which on a 3000² plan is tens of megabytes —
 * and the geometry of one floor does not change between its restarts, or between the passes of
 * an all-floor run. Sending it once and naming it afterwards is the difference between "ninety
 * megabytes of copying" and "a hundred bytes" for every run after the first.
 *
 * The contract has to be explicit, because getting it wrong is silent: a worker that scores a
 * plan it was not given produces a believable layout of the wrong floor. So the bridge clears
 * its idea of what the worker holds whenever it creates or terminates one, the message names
 * the geometry it is talking about, and a message that names something this cache does not hold
 * is refused rather than answered.
 */
export class GeometryCache<T> {
	private held: { id: string; geometry: T } | null = null;

	/**
	 * The geometry a message is about.
	 *
	 * `carried` is the geometry travelling with the message: it becomes what the worker holds.
	 * Otherwise the message must name what is already held — `id` empty means "whatever you
	 * have", which is how a caller that does not track identities behaves.
	 *
	 * Null means the message and this worker disagree about what is loaded, and the caller has
	 * to be told rather than served.
	 */
	resolve(
		carried: { id: string; geometry: T } | null,
		id: string | undefined,
		reused: boolean | undefined
	): T | null {
		if (carried) {
			this.held = carried;
			return carried.geometry;
		}
		if (!this.held) return null;
		if (id && this.held.id !== id) return null;
		return reused ? this.held.geometry : null;
	}
}
