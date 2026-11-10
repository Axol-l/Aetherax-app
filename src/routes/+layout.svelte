<script lang="ts">
// 整个应用的公共布局入口
// 导入全局样式 app.css
// 恢复保存的语言设置
// 安装关闭窗口时的自动保存逻辑
// 渲染当前页面的子内容
	import '../app.css';
	import { onMount } from 'svelte';
	import { restoreLocale } from '$state/i18n.svelte';
	import { installUnloadFlush } from '$state/persistence.svelte';
	import { runGpuDirectProbe } from '$lib/gpu/direct-field.js';

	let { children } = $props();

	onMount(() => {
		if (!new URLSearchParams(location.search).has('gpuProbe')) return;
		void runGpuDirectProbe().then((result) => {
			(window as Window & { __aetheraxGpuProbe?: unknown }).__aetheraxGpuProbe = result;
			document.documentElement.dataset.gpuProbe = result.supported ? 'ok' : 'unsupported';
		});
	});

	// Once, before the rest of the tree renders: the interface language is a stored
	// preference, and every component reads it reactively from here on.
	restoreLocale();

	// The window can close inside the five-second autosave debounce, and a destroyed
	// webview takes the pending write with it. Idempotent, and a no-op during the
	// build-time prerender.
	installUnloadFlush();
</script>

{@render children()}
