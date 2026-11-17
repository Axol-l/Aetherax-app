import adapter from '@sveltejs/adapter-static';

/**
 * The desktop build of the planner.
 *
 * The only difference from the web build is the SPA fallback's name: a static host
 * serves `200.html` for an unknown path by configuration, while Tauri's webview asks
 * for `index.html` and nothing else. Everything else — the aliases, the no-SSR
 * layout, the prerendered shell — is the same app.
 *
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
	kit: {
		adapter: adapter({
			fallback: 'index.html'
		}),
		alias: {
			$components: 'src/lib/components',
			$state: 'src/lib/state',
			$canvas: 'src/lib/canvas'
		}
	}
};

export default config;
