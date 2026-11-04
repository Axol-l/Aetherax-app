<script>
// 整个应用的公共布局入口
// 导入全局样式 app.css
// 恢复保存的语言设置
// 安装关闭窗口时的自动保存逻辑
// 渲染当前页面的子内容
	import '../app.css';
	import { restoreLocale } from '$state/i18n.svelte';
	import { installUnloadFlush } from '$state/persistence.svelte';

	let { children } = $props();

	// Once, before the rest of the tree renders: the interface language is a stored
	// preference, and every component reads it reactively from here on.
	restoreLocale();

	// The window can close inside the five-second autosave debounce, and a destroyed
	// webview takes the pending write with it. Idempotent, and a no-op during the
	// build-time prerender.
	installUnloadFlush();
</script>

{@render children()}
