import { motionDuration } from '$lib/motion.js';

/**
 * A view change is two fades, not a cross-fade.
 *
 * The old view fades to the canvas background, the new view is swapped in while the canvas
 * is completely covered, and only then does it fade back. That keeps the two layouts from
 * being visible at the same time and makes the 3D view — which is drawn by a different
 * layer — behave like every other view.
 *
 * `active` also locks the view buttons and the canvas for the whole run. The CSS transition
 * duration in `CanvasView` must stay in step with `VIEW_FADE_MS`.
 */
export const VIEW_FADE_MS = 160;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

class ViewTransitionState {
	active = $state(false);
	covering = $state(false);
	private running = false;

	async run(commit: () => void): Promise<void> {
		if (this.running) return;
		if (motionDuration(VIEW_FADE_MS) <= 0) {
			commit();
			return;
		}
		this.running = true;
		this.active = true;
		this.covering = true;
		try {
			// Let the cover reach full opacity before the old view is replaced.
			await delay(VIEW_FADE_MS);
			commit();
			// The new layers are installed in an effect and drawn on the next frame. Waiting
			// two frames keeps the fade-in from revealing a half-built overview.
			await nextFrame();
			await nextFrame();
			this.covering = false;
			await delay(VIEW_FADE_MS);
		} finally {
			this.active = false;
			this.covering = false;
			this.running = false;
		}
	}
}

export const viewTransition = new ViewTransitionState();
