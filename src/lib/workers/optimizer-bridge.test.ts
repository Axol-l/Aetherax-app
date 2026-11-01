import { describe, expect, it, beforeEach } from 'vitest';
import { OptimizerBridge, type OptimizeResult } from './optimizer-bridge.js';

/*
 * The bridge's half of the worker protocol.
 *
 * A run is a request the main thread cannot take back once it is posted, so the only way to
 * stay correct is for every reply to say which run it answers. These tests pin that: a reply
 * for an abandoned run must be dropped rather than delivered, a cancel must reject at once
 * and name its run, and a second run must not be able to adopt the first one's result.
 *
 * The worker itself is replaced by a recorder — there is no `Worker` in the node environment
 * this suite runs in, and the part under test here is the filtering, not the search.
 */

interface Posted {
	message: { type: string; runId?: string };
}

class FakeWorker {
	static instances: FakeWorker[] = [];
	posted: Posted[] = [];
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;

	constructor() {
		FakeWorker.instances.push(this);
	}

	postMessage(message: { type: string; runId?: string }): void {
		this.posted.push({ message });
	}

	terminate(): void {}

	static latest(): FakeWorker {
		const worker = FakeWorker.instances.at(-1);
		if (!worker) throw new Error('no worker was constructed');
		return worker;
	}

	/** Deliver a reply from the worker. */
	reply(data: unknown): void {
		this.onmessage?.({ data });
	}

	/** The last message of a kind the bridge posted. */
	lastOfType(type: string): { type: string; runId?: string } | undefined {
		return this.posted.filter((p) => p.message.type === type).at(-1)?.message;
	}
}

function aps() {
	return [
		{
			id: 'a1',
			x: 1,
			y: 2,
			interferenceRadius: 40,
			band: '5ghz' as const,
			assignedChannel: 36,
			channelWidth: 20 as const
		}
	];
}

/** The smallest run that gets as far as posting a message. */
function startRun(bridge: OptimizerBridge): Promise<OptimizeResult> {
	return bridge.optimize(aps(), new Uint8Array(16), 4, 4, 5, { seed: 1 });
}

function result(runId: string, score: number): Record<string, unknown> {
	return {
		type: 'result',
		runId,
		positions: [{ id: 'a1', x: 1, y: 2 }],
		score,
		improvement: 0,
		seed: 1,
		coverage: 1,
		sampleCount: 1,
		reverted: false
	};
}

describe('OptimizerBridge protocol', () => {
	beforeEach(() => {
		FakeWorker.instances = [];
		(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
	});

	it('tags every request with an id of its own', () => {
		startRun(new OptimizerBridge());
		const optimize = FakeWorker.latest().lastOfType('optimize');
		expect(optimize?.runId).toBeTruthy();
	});

	it('drops a reply from a run nobody is waiting for', async () => {
		const bridge = new OptimizerBridge();
		const run = startRun(bridge);
		const worker = FakeWorker.latest();
		const runId = worker.lastOfType('optimize')!.runId!;

		// The layout of a run that outran its cancellation, arriving late. Delivering it
		// would report one run's plan as this run's answer.
		worker.reply(result('a-run-from-before', 999));
		worker.reply(result(runId, 12));

		await expect(run).resolves.toMatchObject({ score: 12 });
	});

	it('rejects at once when cancelled, and cancels the run it was waiting on', async () => {
		const bridge = new OptimizerBridge();
		const settled = startRun(bridge).catch((error: Error) => error);
		const worker = FakeWorker.latest();
		const runId = worker.lastOfType('optimize')!.runId!;

		bridge.cancel();

		// No round trip: the caller unwinds now, and the worker is told which run to stop.
		await expect(settled).resolves.toMatchObject({ message: 'Cancelled' });
		expect(worker.lastOfType('cancel')?.runId).toBe(runId);
	});

	it('does not send a cancel when nothing is in flight', () => {
		const bridge = new OptimizerBridge();
		startRun(bridge);
		const worker = FakeWorker.latest();
		const runId = worker.lastOfType('optimize')!.runId!;
		worker.reply(result(runId, 1));

		return Promise.resolve().then(() => {
			// A cancel that arrives after the run finished must not reach the worker: it
			// would stop the next run, which is one the user has just asked for.
			bridge.cancel();
			expect(worker.lastOfType('cancel')).toBeUndefined();
		});
	});

	it('supersedes the previous run instead of letting it resolve the new one', async () => {
		const bridge = new OptimizerBridge();
		const first = startRun(bridge).catch((error: Error) => error);
		const worker = FakeWorker.latest();
		const firstId = worker.lastOfType('optimize')!.runId!;

		const second = startRun(bridge);

		await expect(first).resolves.toMatchObject({ message: 'Superseded' });
		expect(worker.lastOfType('cancel')?.runId).toBe(firstId);

		// The first run's late reply must not answer the second one.
		worker.reply(result(firstId, 999));
		worker.reply(result(worker.lastOfType('optimize')!.runId!, 7));
		await expect(second).resolves.toMatchObject({ score: 7 });
	});

	it('reports a second concurrent run as refused, not as a result', async () => {
		const bridge = new OptimizerBridge();
		const run = startRun(bridge);
		const worker = FakeWorker.latest();
		const runId = worker.lastOfType('optimize')!.runId!;

		worker.reply({ type: 'busy', runId });

		await expect(run).rejects.toThrow('Another optimisation is still running');
	});
});
