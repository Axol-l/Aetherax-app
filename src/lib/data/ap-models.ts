import type { Band, ChannelWidth } from '@aetherax/channels';
import { UBIQUITI_MODELS } from './vendors/ubiquiti.js';
import { CISCO_MODELS } from './vendors/cisco.js';
import { ARUBA_MODELS } from './vendors/aruba.js';
import { RUCKUS_MODELS } from './vendors/ruckus.js';
import { TPLINK_MODELS } from './vendors/tp-link.js';
import { CONSUMER_MODELS } from './vendors/consumer.js';
import { ENTERPRISE_MODELS } from './vendors/enterprise.js';

export interface ApBandSpec {
	band: Band;
	maxChannelWidth: ChannelWidth;
	maxTxPower: number; // dBm (conducted)
	typicalIndoorRange: number; // meters
	streams: number; // spatial streams (MIMO), e.g. 2 for 2x2, 4 for 4x4
	/** 可选的型号天线预设；未给出时按频段/安装方式取保守默认。 */
	beamwidthDeg?: number;
	aimDeg?: number;
}

export interface ApModel {
	id: string;
	vendor: string;
	model: string;
	wifiStandard: string;
	bands: ApBandSpec[];
}

/** All AP models aggregated from per-vendor files. */
export const AP_MODELS: readonly ApModel[] = [
	...UBIQUITI_MODELS,
	...CISCO_MODELS,
	...ARUBA_MODELS,
	...RUCKUS_MODELS,
	...TPLINK_MODELS,
	...CONSUMER_MODELS,
	...ENTERPRISE_MODELS
];

/** Find a model by ID */
export function findModel(id: string): ApModel | undefined {
	return AP_MODELS.find((m) => m.id === id);
}

/**
 * A planning default for how many concurrent clients this model can carry.
 *
 * Vendors quote different figures for different traffic mixes, so this is only a starting
 * point: the AP editor exposes the value and the project setting remains the fallback.
 */
export function recommendedClients(model: ApModel): number {
	const wifi = Number(model.wifiStandard.match(/WiFi\s+(\d)/)?.[1] ?? 5);
	const streams = Math.max(1, ...model.bands.map((band) => band.streams));
	const perStream = wifi >= 7 ? 25 : wifi >= 6 ? 20 : 15;
	return Math.min(150, Math.max(10, streams * perStream));
}

/**
 * 型号的 Beam/Aim 预设。
 *
 * 优先使用型号数据里显式给出的方向图；没有时按频段和安装方式取保守默认。
 * 这是型号级默认，不是厂商实测方向图。
 */
export function recommendedAntenna(
	model: ApModel,
	spec: ApBandSpec,
	mount: 'ceiling' | 'floor' | 'wall' = 'ceiling'
): { beamwidthDeg: number; aimDeg: number } {
	const bandDefault = spec.band === '2.4ghz' ? 120 : 60;
	return {
		beamwidthDeg: spec.beamwidthDeg ?? bandDefault,
		aimDeg: spec.aimDeg ?? (mount === 'ceiling' ? 30 : 0)
	};
}

/** Search models by query (fuzzy match on vendor + model + wifi standard) */export function searchModels(query: string): ApModel[] {
	if (!query.trim()) return [...AP_MODELS];
	const q = query.toLowerCase();
	return AP_MODELS.filter(
		(m) =>
			m.vendor.toLowerCase().includes(q) ||
			m.model.toLowerCase().includes(q) ||
			m.wifiStandard.toLowerCase().includes(q) ||
			m.id.includes(q)
	);
}

/** Group models by vendor */
export function getModelsByVendor(): Map<string, ApModel[]> {
	const map = new Map<string, ApModel[]>();
	for (const m of AP_MODELS) {
		const list = map.get(m.vendor) ?? [];
		list.push(m);
		map.set(m.vendor, list);
	}
	return map;
}

/** Get the band spec for a model that matches the given band, or the best available */
export function getBandSpec(model: ApModel, preferredBand: Band): ApBandSpec | undefined {
	return model.bands.find((b) => b.band === preferredBand) ?? model.bands[model.bands.length - 1];
}
