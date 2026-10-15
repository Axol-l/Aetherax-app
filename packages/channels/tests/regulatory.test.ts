import { describe, it, expect } from 'vitest';
import {
	getAvailableChannels,
	nonOverlappingChannels,
	planningCandidates,
	planningChannels
} from '../src/regulatory.js';
import { channelsInterfere } from '../src/overlap.js';

describe('getAvailableChannels', () => {
	it('FCC 2.4 GHz returns 11 channels', () => {
		const channels = getAvailableChannels('2.4ghz', 'fcc');
		expect(channels).toHaveLength(11);
	});

	it('ETSI 2.4 GHz returns 13 channels', () => {
		const channels = getAvailableChannels('2.4ghz', 'etsi');
		expect(channels).toHaveLength(13);
	});

	it('5 GHz without DFS excludes channels 52-64 and 100-144', () => {
		const channels = getAvailableChannels('5ghz', 'fcc');
		const numbers = channels.map((c) => c.number);
		expect(numbers).not.toContain(52);
		expect(numbers).not.toContain(64);
		expect(numbers).not.toContain(100);
		expect(numbers).not.toContain(144);
		expect(numbers).toContain(36);
		expect(numbers).toContain(149);
	});

	it('5 GHz with DFS includes all channels', () => {
		const channels = getAvailableChannels('5ghz', 'fcc', { includeDfs: true });
		expect(channels).toHaveLength(25);
	});
});

/**
 * Eleven channels are available at 2.4 GHz and only three do not overlap. The
 * distinction is the input to a decision — see `docs/ROADMAP.md` B2/B3 — so it is
 * pinned here rather than left to the caller to remember.
 */
describe('nonOverlappingChannels', () => {
	it('finds the three non-overlapping 2.4 GHz channels', () => {
		const chosen = nonOverlappingChannels(getAvailableChannels('2.4ghz', 'fcc'), 20);
		expect(chosen.map((c) => c.number)).toEqual([1, 6, 11]);
	});

	it('narrows as the channel gets wider', () => {
		const available = getAvailableChannels('5ghz', 'fcc');
		const at20 = nonOverlappingChannels(available, 20).length;
		const at160 = nonOverlappingChannels(available, 160).length;
		expect(at20).toBeGreaterThan(at160);
		expect(at160).toBeGreaterThan(0);
	});
});

/**
 * What an automatic assignment may use, and therefore the set on which "different
 * channel number" and "does not interfere" are the same statement. See B3.
 */
describe('planningChannels', () => {
	it('gives 2.4 GHz three channels, not eleven', () => {
		// The eleven *permitted* channels overlap; handing them out as if independent
		// is what made the optimiser's interference term unreachable on an unpinned
		// plan, because a solver with eleven colours never reuses one.
		expect(planningChannels('2.4ghz', 'fcc', 20).map((c) => c.number)).toEqual([1, 6, 11]);
		// ETSI also permits 12 and 13, and they are still excluded: 13 overlaps 11 by
		// two channel widths. The greedy pick from the low end does not hunt for the
		// equally-sized alternative {1, 7, 13}, and it does not need to — three is the
		// most that fits either way.
		expect(planningChannels('2.4ghz', 'etsi', 20).map((c) => c.number)).toEqual([1, 6, 11]);
	});

	it('keeps every 5 GHz channel at 20 MHz, where they already do not overlap', () => {
		// 5 GHz numbers are 20 MHz apart, so a 20 MHz channel never overlaps its
		// neighbour: the palette and the permitted list are the same set here, and the
		// restriction costs nothing.
		const available = getAvailableChannels('5ghz', 'fcc').map((c) => c.number);
		expect(planningChannels('5ghz', 'fcc', 20).map((c) => c.number)).toEqual(available);
	});

	it('costs real channels once 5 GHz is bonded', () => {
		// An 80 MHz channel needs four 20 MHz blocks, so most of the band's channel
		// numbers are no longer usable side by side. This is the case the interval
		// model (B3 stage two) exists for.
		const wide = planningChannels('5ghz', 'fcc', 80).length;
		const narrow = planningChannels('5ghz', 'fcc', 20).length;
		expect(wide).toBeGreaterThan(0);
		expect(wide).toBeLessThan(narrow / 2);
	});

	it('returns channels that are pairwise non-interfering, which is the point', () => {
		for (const band of ['2.4ghz', '5ghz', '6ghz'] as const) {
			for (const width of [20, 40, 80] as const) {
				const palette = planningChannels(band, 'fcc', width);
				for (const a of palette) {
					for (const b of palette) {
						if (a.number === b.number) continue;
						expect(channelsInterfere(a, b, width, width)).toBe(false);
					}
				}
			}
		}
	});
});

describe('planningCandidates', () => {
	it('starts with the palette, then offers the rest', () => {
		const candidates = planningCandidates('2.4ghz', 'fcc', 20).map((c) => c.number);
		expect(candidates.slice(0, 3)).toEqual([1, 6, 11]);
		expect(candidates).toHaveLength(11);
		expect(new Set(candidates).size).toBe(11);
	});

	it('offers nothing the domain does not permit', () => {
		const fcc = planningCandidates('2.4ghz', 'fcc', 20).map((c) => c.number);
		expect(fcc).not.toContain(12);
		const etsi = planningCandidates('2.4ghz', 'etsi', 20).map((c) => c.number);
		expect(etsi).toContain(13);
	});

	it('is the palette itself when the palette already covers the band', () => {
		// 5 GHz at 20 MHz: the permitted channels do not overlap each other, so there
		// is nothing left over and the widening is empty.
		const candidates = planningCandidates('5ghz', 'fcc', 20);
		expect(candidates.map((c) => c.number)).toEqual(
			planningChannels('5ghz', 'fcc', 20).map((c) => c.number)
		);
	});

	it('has more room than the palette once widths are mixed', () => {
		// The case B3 stage two is about: at 80 MHz the non-DFS 5 GHz palette is
		// small, and a 20 MHz source that only has to keep clear of the APs it
		// actually conflicts with can use far more centres than that.
		const wide = planningChannels('5ghz', 'fcc', 80).map((c) => c.number);
		const narrow = planningCandidates('5ghz', 'fcc', 20).map((c) => c.number);
		expect(wide).toEqual([36, 149, 165]);
		expect(narrow.filter((n) => !wide.includes(n)).length).toBeGreaterThan(3);
	});
});
