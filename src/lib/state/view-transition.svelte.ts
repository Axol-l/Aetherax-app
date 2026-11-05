import { motionDuration } from '$lib/motion.js';

/**
 * 视图切换是两次淡出淡入，不是交叉淡化。
 *
 * 旧视图淡到画布背景色，画布被完全盖住时换上新视图，然后再淡回来。这样两套布局不会同时露脸，
 * 也顺带让用另一层绘制的三维视图和其它视图表现一致。
 *
 * `active` 期间视图按钮和画布都锁住。`CanvasView` 里 CSS 过渡的时长必须和 `VIEW_FADE_MS` 保持一致。
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
			// 等遮罩完全变不透明，再换掉旧视图。
			await delay(VIEW_FADE_MS);
			commit();
			// 新图层是在 effect 里装的、下一帧才画出来。等两帧，免得淡入时露出半成品。
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
