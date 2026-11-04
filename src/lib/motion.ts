// 根据系统设置调整动画时长

export function motionDuration(milliseconds: number): number {
	if (typeof window === 'undefined') return 0;
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : milliseconds;
}
