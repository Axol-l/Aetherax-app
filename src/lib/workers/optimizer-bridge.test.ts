import { describe, expect, it, beforeEach } from 'vitest';
import { OptimizerBridge, type OptimizeResult } from './optimizer-bridge.js';
import type { ApInput } from './optimizer-protocol.js';
/*
 * 桥接这一侧的 Worker 协议测试。
 *
 * 运行请求发出去就收不回来，所以每条回复都得说清自己在答哪次运行。测试钉住三件事：
 * 被放弃的运行的回复要丢掉、取消要立刻 reject 并带上运行编号、第二次运行拿不到第一次的结果。
 * Worker 换成了记录器：node 环境里没有 `Worker`，而且这里要测的是过滤，不是搜索。
 */

interface Posted {
	message: { type: string; runId?: string; geometryId?: string; wallMask?: unknown; geometryReused?: boolean };
	transfer: unknown[];
}

class FakeWorker {
	static instances: FakeWorker[] = [];
	posted: Posted[] = [];
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;

	constructor() {
		FakeWorker.instances.push(this);
	}

	postMessage(message: Posted['message'], transfer: unknown[] = []): void {
		this.posted.push({ message, transfer });
	}

	terminate(): void {}

	static latest(): FakeWorker {
		const worker = FakeWorker.instances.at(-1);
		if (!worker) throw new Error('no worker was constructed');
		return worker;
	}

	/** 模拟 Worker 发回一条消息。 */
	reply(data: unknown): void {
		this.onmessage?.({ data });
	}

	/** 桥接发过的某类消息里，最后那一条。 */
	lastOfType(type: string): Posted['message'] | undefined {
		return this.posted.filter((p) => p.message.type === type).at(-1)?.message;
	}
}

/** 一条完整的消息数据：桥接要的是 `ApInput`，天线字段也得带上。 */
function aps(): ApInput[] {
	return [
		{
			id: 'a1',
			x: 1,
			y: 2,
			interferenceRadius: 40,
			band: '5ghz' as const,
			assignedChannel: 36,
			fixedChannel: null,
			channelWidth: 20 as const,
			beamwidthDeg: 360,
			aimDeg: 0,
			mount: 'ceiling' as const,
			facingDeg: 0,
			verticalGap: 0
		}
	];
}

/** 能走到发消息这一步的最小一次运行。 */
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

		// 一次运行赶在取消之前跑完了，回复晚到。收下它就会把别人的布局当成本次运行的答案。
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

		// 不走来回：调用方立刻退出，同时告诉 Worker 停哪次运行。
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
			// 运行已经结束后才来的取消，不能发给 Worker：那会停掉下一次运行，也就是用户刚点的那次。
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

		// 第一次运行迟到的回复，不能当成第二次的答案。
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

	it('sends the plan once, and the parameters on every run after it', async () => {
		const bridge = new OptimizerBridge();
		const mask = new Uint8Array(16);

		const first = bridge
			.optimize(aps(), mask, 4, 4, 5, { seed: 1 })
			.catch((error: Error) => error);
		const worker = FakeWorker.latest();
		const firstMessage = worker.lastOfType('optimize')!;
		worker.reply(result(firstMessage.runId!, 1));
		await first;

		// 同一个掩码数组就是同一份方案：多次重启不能每次都把 9MB 的墙体传一遍。
		const second = bridge.optimize(aps(), mask, 4, 4, 5, { seed: 2 });
		const secondMessage = worker.lastOfType('optimize')!;
		expect(secondMessage.wallMask).toBeUndefined();
		expect(secondMessage.geometryReused).toBe(true);
		expect(secondMessage.geometryId).toBe(firstMessage.geometryId);
		expect(worker.posted.at(-1)!.transfer).toEqual([]);
		worker.reply(result(secondMessage.runId!, 2));
		await second;

		// 换了方案就是换了户型几何，得重新发。
		const third = bridge.optimize(aps(), new Uint8Array(16), 4, 4, 5, { seed: 3 });
		const thirdMessage = worker.lastOfType('optimize')!;
		expect(thirdMessage.geometryReused).toBe(false);
		expect(thirdMessage.wallMask).toBeInstanceOf(Uint8Array);
		worker.reply(result(thirdMessage.runId!, 3));
		await third;
	});

	it('sends the plan again to a worker that was restarted', async () => {
		const bridge = new OptimizerBridge();
		const mask = new Uint8Array(16);

		const first = bridge.optimize(aps(), mask, 4, 4, 5, { seed: 1 });
		const worker = FakeWorker.latest();
		worker.reply(result(worker.lastOfType('optimize')!.runId!, 1));
		await first;

		bridge.terminate();

		// 新建的 Worker 什么都没收到，还说「户型还在」就是骗自己，算分时手上根本没有数据。
		const second = bridge.optimize(aps(), mask, 4, 4, 5, { seed: 2 });
		const resent = FakeWorker.latest().lastOfType('optimize')!;
		expect(resent.geometryReused).toBe(false);
		expect(resent.wallMask).toBeInstanceOf(Uint8Array);
		FakeWorker.latest().reply(result(resent.runId!, 2));
		await second;
	});
});
