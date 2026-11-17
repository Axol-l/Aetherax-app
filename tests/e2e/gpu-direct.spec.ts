import { expect, test } from '@playwright/test';

// Headless Chromium often has no adapter. Set GPU_PROBE_CHANNEL=msedge to run the
// probe against Edge's WebGPU stack; otherwise the test skips when unsupported.
test.use({
	channel: (process.env.GPU_PROBE_CHANNEL as 'msedge' | undefined) || undefined
});

test('WebGPU direct-field probe matches the CPU reference', async ({ page }) => {
	await page.goto('/?gpuProbe=1');
	await page.waitForFunction(() => {
		const probe = (window as Window & { __aetheraxGpuProbe?: unknown }).__aetheraxGpuProbe;
		return !!probe;
	});
	const probe = await page.evaluate(
		() =>
			(window as Window & { __aetheraxGpuProbe?: unknown }).__aetheraxGpuProbe as
				| {
						supported: boolean;
						reason?: string;
						cpuMs: number;
						gpuMs: number;
						maxAbsErrorDb: number;
						meanAbsErrorDb: number;
						mismatchedAp: number;
				  }
				| undefined
	);
	test.skip(!probe?.supported, `WebGPU unavailable: ${probe?.reason ?? 'no result'}`);
	console.log('GPU_PROBE', JSON.stringify(probe));
	expect(probe!.maxAbsErrorDb).toBeLessThan(1);
	expect(probe!.meanAbsErrorDb).toBeLessThan(0.1);
	expect(probe!.mismatchedAp).toBe(0);
	expect(probe!.cpuMs).toBeGreaterThan(0);
	expect(probe!.gpuMs).toBeGreaterThan(0);
});

test('per-AP WebGPU direct field matches the CPU reference', async ({ page }) => {
	await page.goto('/?gpuProbe=1');
	await page.waitForFunction(() => {
		const probe = (window as Window & { __aetheraxGpuPerApProbe?: unknown })
			.__aetheraxGpuPerApProbe;
		return !!probe;
	});
	const probe = await page.evaluate(
		() =>
			(window as Window & { __aetheraxGpuPerApProbe?: unknown })
				.__aetheraxGpuPerApProbe as
				| {
						supported: boolean;
						reason?: string;
						cpuMs: number;
						gpuMs: number;
						apCount: number;
						maxAbsErrorDb: number;
						meanAbsErrorDb: number;
				  }
				| undefined
	);
	test.skip(!probe?.supported, `WebGPU unavailable: ${probe?.reason ?? 'no result'}`);
	console.log('GPU_PER_AP_PROBE', JSON.stringify(probe));
	expect(probe!.apCount).toBe(2);
	expect(probe!.maxAbsErrorDb).toBeLessThan(1);
	expect(probe!.meanAbsErrorDb).toBeLessThan(0.1);
	expect(probe!.gpuMs).toBeGreaterThan(0);
});

test('production-aligned GPU direct field matches the CPU reference', async ({ page }) => {
	await page.goto('/?gpuProbe=1');
	await page.waitForFunction(() => {
		const probe = (window as Window & { __aetheraxGpuProductionProbe?: unknown })
			.__aetheraxGpuProductionProbe;
		return !!probe;
	});
	const probe = await page.evaluate(
		() =>
			(window as Window & { __aetheraxGpuProductionProbe?: unknown })
				.__aetheraxGpuProductionProbe as
				| {
						supported: boolean;
						reason?: string;
						cpuMs: number;
						gpuMs: number;
						maxAbsErrorDb: number;
						meanAbsErrorDb: number;
				  }
				| undefined
	);
	test.skip(!probe?.supported, `WebGPU unavailable: ${probe?.reason ?? 'no result'}`);
	console.log('GPU_PRODUCTION_PROBE', JSON.stringify(probe));
	expect(probe!.maxAbsErrorDb).toBeLessThan(1);
	expect(probe!.meanAbsErrorDb).toBeLessThan(0.1);
	expect(probe!.cpuMs).toBeGreaterThan(0);
	expect(probe!.gpuMs).toBeGreaterThan(0);
});
