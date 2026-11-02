<script>
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
