import { describe, expect, it } from 'vitest';
import {
	ADJACENT_GAP_MHZ,
	DEFAULT_ACIR_DB,
	channelCenterMhz,
	channelInterferenceWeight
} from '../src/interference.js';

const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);
const a = 10 ** (-DEFAULT_ACIR_DB / 10);

describe('adjacent-channel weighting', () => {
	it('treats the same channel as full co-channel interference', () => {
		near(
			channelInterferenceWeight(
				{ band: '5ghz', assignedChannel: 36, channelWidth: 20 },
				{ band: '5ghz', assignedChannel: 36, channelWidth: 20 }
			),
			1
		);
	});

	it('weights a partially overlapping 2.4 GHz channel', () => {
		near(
			channelInterferenceWeight(
				{ band: '2.4ghz', assignedChannel: 1, channelWidth: 20 },
				{ band: '2.4ghz', assignedChannel: 2, channelWidth: 20 }
			),
			0.75 * a
		);
	});

	it('gives the minimum leak weight to a non-overlapping first neighbour', () => {
		near(
			channelInterferenceWeight(
				{ band: '2.4ghz', assignedChannel: 1, channelWidth: 20 },
				{ band: '2.4ghz', assignedChannel: 6, channelWidth: 20 }
			),
			a
		);
		near(
			channelInterferenceWeight(
				{ band: '5ghz', assignedChannel: 36, channelWidth: 20 },
				{ band: '5ghz', assignedChannel: 40, channelWidth: 20 }
			),
			a
		);
	});

	it('does not leak across a full channel gap', () => {
		near(
			channelInterferenceWeight(
				{ band: '2.4ghz', assignedChannel: 1, channelWidth: 20 },
				{ band: '2.4ghz', assignedChannel: 11, channelWidth: 20 }
			),
			0
		);
		near(
			channelInterferenceWeight(
				{ band: '5ghz', assignedChannel: 36, channelWidth: 20 },
				{ band: '5ghz', assignedChannel: 44, channelWidth: 20 }
			),
			0
		);
	});

	it('keeps containment co-channel and scales a wide server by occupied bandwidth', () => {
		const server20 = { band: '5ghz' as const, assignedChannel: 48, channelWidth: 20 as const };
		const wide80 = { band: '5ghz' as const, assignedChannel: 36, channelWidth: 80 as const };
		near(channelInterferenceWeight(server20, wide80), 1);

		const server80 = { band: '5ghz' as const, assignedChannel: 36, channelWidth: 80 as const };
		const narrow20 = { band: '5ghz' as const, assignedChannel: 48, channelWidth: 20 as const };
		near(channelInterferenceWeight(server80, narrow20), 0.25);
	});

	it('ignores another band and keeps missing channels conservative', () => {
		near(
			channelInterferenceWeight(
				{ band: '5ghz', assignedChannel: 36, channelWidth: 20 },
				{ band: '2.4ghz', assignedChannel: 1, channelWidth: 20 }
			),
			0
		);
		near(
			channelInterferenceWeight(
				{ band: '5ghz', assignedChannel: null, channelWidth: 20 },
				{ band: '5ghz', assignedChannel: 36, channelWidth: 20 }
			),
			1
		);
	});

	it('uses the 80/160 channel-group centre, not the primary channel centre', () => {
		expect(channelCenterMhz('5ghz', 36, 80)).toBe(5210);
		expect(channelCenterMhz('5ghz', 48, 80)).toBe(5210);
		expect(channelCenterMhz('5ghz', 36, 160)).toBe(5250);
		expect(channelCenterMhz('5ghz', 48, 160)).toBe(5250);
		expect(ADJACENT_GAP_MHZ).toBe(5);
	});
});
