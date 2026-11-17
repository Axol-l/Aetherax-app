<script lang="ts">
	import type { Snippet } from 'svelte';
	import { slide } from 'svelte/transition';
	import { motionDuration } from '$lib/motion.js';

	let { open, children }: { open: boolean; children: Snippet } = $props();
</script>

{#if open}
	<div class="collapse" transition:slide={{ duration: motionDuration(180) }}>
		{@render children()}
	</div>
{/if}

<style>
	.collapse {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
</style>
