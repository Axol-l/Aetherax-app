<script>
	import '../app.css';
	import { restoreLocale } from '$state/i18n.svelte';
	import NoticeToast from '$components/layout/NoticeToast.svelte';

	let { children } = $props();

	// Once, before the rest of the tree renders: the interface language is a stored
	// preference, and every component reads it reactively from here on.
	restoreLocale();
</script>

{@render children()}
<NoticeToast />
