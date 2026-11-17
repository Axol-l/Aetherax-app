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
	import { runGpuPerApProbe } from '$lib/gpu/direct-field-per-ap.js';
	import { runProductionProbe } from '$lib/gpu/production-direct.js';

	let { children } = $props();

	onMount(() => {
		if (!new URLSearchParams(location.search).has('gpuProbe')) return;
		void runGpuDirectProbe().then(async (result) => {
			(window as Window & { __aetheraxGpuProbe?: unknown }).__aetheraxGpuProbe = result;
			document.documentElement.dataset.gpuProbe = result.supported ? 'ok' : 'unsupported';
			// Run the per-AP probe after the strongest-AP one so the two do not compete
			// for the same device while being timed.
			const perAp = await runGpuPerApProbe();
			(window as Window & { __aetheraxGpuPerApProbe?: unknown }).__aetheraxGpuPerApProbe =
				perAp;
			document.documentElement.dataset.gpuPerApProbe = perAp.supported
				? 'ok'
				: 'unsupported';
			const production = await runProductionProbe();
			(window as Window & { __aetheraxGpuProductionProbe?: unknown })
				.__aetheraxGpuProductionProbe = production;
			document.documentElement.dataset.gpuProductionProbe = production.supported
				? 'ok'
				: 'unsupported';
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
