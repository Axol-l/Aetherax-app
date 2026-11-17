/**
 * 整栋均值必须跟着 `floorCoverage` 走，不能是某次运行抄下来的快照。
 *
 * 最弱层补跑只改一层；快照停在最后一整轮，于是侧边栏的整栋数字和布点建议里的“整栋 X%”
 * 会差一个时刻，`rebalance-floor` 那条 15 个点的判据也就跟着判错。这里钉的是数据来源本身。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	floorCoverage,
	getBuildingCoverage,
	measuredBuildingCoverage
} from './optimizer-state.svelte.js';

beforeEach(() => floorCoverage.clear());

describe('building coverage', () => {
	it('is null until a floor has been measured', () => {
		expect(measuredBuildingCoverage()).toBeNull();
		// 面板上仍然显示 0%，这样“0%”和“没测过”在两种读者眼里是可区分的。
		expect(getBuildingCoverage()).toBe(0);
	});

	it('follows the per-floor cache when a retry rewrites one floor', () => {
		floorCoverage.set('f1', { coverage: 90, samples: 100 });
		floorCoverage.set('f2', { coverage: 40, samples: 100 });
		expect(measuredBuildingCoverage()).toBe(65);

		// 补跑给 f2 提交了新方案：均值必须跟着这一层一起动。
		floorCoverage.set('f2', { coverage: 60, samples: 100 });
		expect(measuredBuildingCoverage()).toBe(75);
	});

	it('weights by sample count, so a small storey counts for less', () => {
		floorCoverage.set('f1', { coverage: 100, samples: 900 });
		floorCoverage.set('f2', { coverage: 0, samples: 100 });
		expect(getBuildingCoverage()).toBe(90);
		// 丢掉一层不会让均值变成 0：它只是少了一个权重。
		floorCoverage.delete('f2');
		expect(getBuildingCoverage()).toBe(100);
	});
});
