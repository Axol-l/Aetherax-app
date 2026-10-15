import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests',
	outputDir: 'test-results',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? 'github' : 'html',
	use: {
		// Bind IPv4 explicitly: on some Windows hosts `vite preview` listens on ::1 only,
		// while Chromium resolves 127.0.0.1 first and fails with ERR_CONNECTION_REFUSED.
		baseURL: 'http://127.0.0.1:4183',
		trace: 'on-first-retry',
		screenshot: 'only-on-failure'
	},
	webServer: {
		command: 'pnpm build && pnpm preview --port 4183 --host 127.0.0.1',
		// `url` rather than `port`: the readiness probe must use the same IPv4
		// address as baseURL, not `localhost`, which can resolve to ::1 first.
		url: 'http://127.0.0.1:4183',
		reuseExistingServer: !process.env.CI,
		timeout: 60000
	}
});
