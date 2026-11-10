/**
 * 与生产热力图直射项对齐的 GPU 原型。
 *
 * 对齐内容：
 * - `apRefDb` + `relativePathLossDb`（ITU 对数距离曲线/折断点）；
 * - 栅格墙体 + 材质表 + `rayMarchWallAtten` 的穿墙损耗；
 * - 每 AP 的固定楼板损耗。
 *
 * 天线方向图不放进 WGSL：GPU 输出不含天线的逐 AP 基础电平，CPU 再按像素加
 * `antennaRayLossDb`。这样不用在 shader 里复制一份方向图公式。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { relativePathLossDbAt } from '../rf/propagation.js';
import { wallRunLoss, type WallRun } from '../rf/link-budget.js';
import { antennaRayLossDb, type AntennaProfile } from '../rf/antenna.js';

export interface ProductionDirectAp {
	x: number;
	y: number;
	/** 1 m 处参考电平：AP 功率减 PL0。 */
	referenceDbm: number;
	pathLossExponent: number;
	verticalGapM: number;
	slabLossDb: number;
}

export interface ProductionDirectMask {
	/** 解码后的 0/1 墙体掩码。 */
	data: Uint8Array;
	width: number;
	height: number;
	originX: number;
	originY: number;
	materialMap: Uint8Array | null;
	materialDb: number[];
	fallbackDb: number;
	defaultMaterialId: number;
	stride: number;
}

export interface ProductionDirectInput {
	width: number;
	height: number;
	originX: number;
	originY: number;
	texel: number;
	worldUnitsPerMeter: number;
	aps: ProductionDirectAp[];
	wallMask?: ProductionDirectMask | null;
}

export interface ProductionDirectResult {
	/** `apIndex * pixelCount + pixel`，dBm，不含天线。 */
	dbm: Float32Array;
	apCount: number;
	pixels: number;
	ms: number;
}

/** CPU 参考；与生产热力图的直射项使用同一组函数。 */
export function productionDirectCpu(input: ProductionDirectInput): ProductionDirectResult {
	const started = performance.now();
	const pixels = input.width * input.height;
	const dbm = new Float32Array(pixels * input.aps.length);
	const wallRun: WallRun | null = input.wallMask
		? {
				mask: input.wallMask.data,
				width: input.wallMask.width,
				height: input.wallMask.height,
				materialMask: input.wallMask.materialMap,
				materialDb: input.wallMask.materialDb,
				fallbackDb: input.wallMask.fallbackDb,
				originX: input.wallMask.originX,
				originY: input.wallMask.originY,
				defaultMaterialId: input.wallMask.defaultMaterialId
			}
		: null;
	for (let apIndex = 0; apIndex < input.aps.length; apIndex++) {
		const ap = input.aps[apIndex]!;
		const offset = apIndex * pixels;
		for (let py = 0; py < input.height; py++) {
			const wy = input.originY + (py + 0.5) * input.texel;
			for (let px = 0; px < input.width; px++) {
				const wx = input.originX + (px + 0.5) * input.texel;
				const dx = wx - ap.x;
				const dy = wy - ap.y;
				const horizontalM = Math.hypot(dx, dy) / input.worldUnitsPerMeter;
				const distanceM = Math.max(0.1, Math.hypot(horizontalM, ap.verticalGapM));
				const wallLoss =
					wallRun && input.wallMask
						? wallRunLoss(
								wallRun,
								{ x: ap.x, y: ap.y },
								{ x: wx, y: wy },
								input.wallMask.stride
							)
						: 0;
				dbm[offset + py * input.width + px] =
					ap.referenceDbm -
					relativePathLossDbAt(distanceM, ap.pathLossExponent) -
					wallLoss -
					ap.slabLossDb;
			}
		}
	}
	return { dbm, apCount: input.aps.length, pixels, ms: performance.now() - started };
}

/** CPU 后处理：按像素把天线方向图损耗从 GPU 基础电平里扣除。 */
export function applyProductionAntenna(
	input: ProductionDirectInput,
	result: ProductionDirectResult,
	apIndex: number,
	profile: AntennaProfile
): void {
	const ap = input.aps[apIndex];
	if (!ap) return;
	for (let py = 0; py < input.height; py++) {
		const wy = input.originY + (py + 0.5) * input.texel;
		for (let px = 0; px < input.width; px++) {
			const wx = input.originX + (px + 0.5) * input.texel;
			const dx = wx - ap.x;
			const dy = wy - ap.y;
			const index = apIndex * result.pixels + py * input.width + px;
			result.dbm[index]! -= antennaRayLossDb(profile, ap.verticalGapM, dx, dy);
		}
	}
}

const SHADER = /* wgsl */ `
struct Uniforms {
	width: u32,
	height: u32,
	apCount: u32,
	maskWidth: u32,
	maskHeight: u32,
	hasMaterial: u32,
	stride: f32,
	maskOriginX: f32,
	maskOriginY: f32,
	texel: f32,
	worldUnitsPerMeter: f32,
	originX: f32,
	originY: f32,
	fallbackDb: f32,
	defaultMaterialId: u32,
	pad0: u32,
};

struct Ap {
	x: f32,
	y: f32,
	referenceDbm: f32,
	pathLossExponent: f32,
	verticalGapM: f32,
	slabLossDb: f32,
	pad0: f32,
	pad1: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> aps: array<Ap>;
@group(0) @binding(2) var<storage, read> wallBits: array<u32>;
@group(0) @binding(3) var<storage, read> materialBits: array<u32>;
@group(0) @binding(4) var<storage, read> materialDb: array<f32>;
@group(0) @binding(5) var<storage, read_write> out: array<f32>;

fn wallByte(px: i32, py: i32) -> u32 {
	if (px < 0 || py < 0 || px >= i32(u.maskWidth) || py >= i32(u.maskHeight)) { return 0u; }
	let index = u32(py) * u.maskWidth + u32(px);
	let bits = wallBits[index >> 2u];
	return (bits >> ((index & 3u) * 8u)) & 255u;
}

fn materialByte(px: i32, py: i32) -> u32 {
	if (px < 0 || py < 0 || px >= i32(u.maskWidth) || py >= i32(u.maskHeight)) { return 0u; }
	let index = u32(py) * u.maskWidth + u32(px);
	let bits = materialBits[index >> 2u];
	return (bits >> ((index & 3u) * 8u)) & 255u;
}

fn rampIntegral(uValue: f32) -> f32 {
	let lo = 0.8;
	let hi = 1.2;
	if (uValue <= lo) { return 0.0; }
	if (uValue >= hi) { return 0.2 + (uValue - hi); }
	let t = (uValue - lo) / 0.4;
	return t * t * 0.2;
}

fn relativePathLoss(distanceMeters: f32, n: f32) -> f32 {
	let d = max(distanceMeters, 1.0);
	let uValue = log2(d) / log2(10.0);
	if (n >= 4.0) { return 10.0 * n * uValue; }
	return 10.0 * (n * uValue + (4.0 - n) * rampIntegral(uValue));
}

fn rayMarchWallLoss(x0: f32, y0: f32, x1: f32, y1: f32) -> f32 {
	if (u.maskWidth == 0u || u.maskHeight == 0u) { return 0.0; }
	let ix0 = i32(floor(x0 + 0.5));
	let iy0 = i32(floor(y0 + 0.5));
	let lenX = i32(floor(x1 + 0.5)) - ix0;
	let lenY = i32(floor(y1 + 0.5)) - iy0;
	let steps = max(abs(lenX), abs(lenY));
	if (steps <= 0) { return 0.0; }
	let n = u32(ceil(f32(steps) / max(u.stride, 1.0)));
	if (n == 0u) { return 0.0; }
	let dx = f32(lenX) / f32(n);
	let dy = f32(lenY) / f32(n);
	var total = 0.0;
	var runMaterial = -1;
	for (var s = 0u; s <= n; s = s + 1u) {
		let px = i32(f32(ix0) + f32(s) * dx + 0.5);
		let py = i32(f32(iy0) + f32(s) * dy + 0.5);
		let wall = wallByte(px, py);
		if (wall == 1u) {
			var matId = i32(u.defaultMaterialId);
			if (u.hasMaterial == 1u) { matId = i32(materialByte(px, py)); }
			if (matId != runMaterial) {
				let db = select(u.fallbackDb, materialDb[u32(matId)], u32(matId) < arrayLength(&materialDb));
				total += db;
				runMaterial = matId;
			}
		} else {
			runMaterial = -1;
		}
	}
	return total;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	if (gid.x >= u.width || gid.y >= u.height || gid.z >= u.apCount) { return; }
	let ap = aps[gid.z];
	let wx = u.originX + (f32(gid.x) + 0.5) * u.texel;
	let wy = u.originY + (f32(gid.y) + 0.5) * u.texel;
	let dx = wx - ap.x;
	let dy = wy - ap.y;
	let horizontalM = sqrt(dx * dx + dy * dy) / u.worldUnitsPerMeter;
	let distanceM = max(0.1, sqrt(horizontalM * horizontalM + ap.verticalGapM * ap.verticalGapM));
	let wallLoss = rayMarchWallLoss(ap.x - u.maskOriginX, ap.y - u.maskOriginY, wx - u.maskOriginX, wy - u.maskOriginY);
	let level = ap.referenceDbm - relativePathLoss(distanceM, ap.pathLossExponent) - wallLoss - ap.slabLossDb;
	let index = gid.z * u.width * u.height + gid.y * u.width + gid.x;
	out[index] = level;
}
`;

const USAGE = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
const MAP_READ = 1;

let devicePromise: Promise<any | null> | null = null;

function sharedDevice(): Promise<any | null> {
	if (!devicePromise) {
		devicePromise = (async () => {
			const gpu = (navigator as any).gpu;
			if (!gpu) return null;
			const adapter = await gpu.requestAdapter();
			if (!adapter) return null;
			return adapter.requestDevice();
		})();
	}
	return devicePromise;
}

function packBytes(data: Uint8Array | null): Uint32Array {
	if (!data || data.length === 0) return new Uint32Array(1);
	const packed = new Uint32Array(Math.ceil(data.length / 4));
	for (let i = 0; i < data.length; i++) {
		const word = i >> 2;
		packed[word] = (packed[word] ?? 0) | ((data[i] ?? 0) << ((i & 3) * 8));
	}
	return packed;
}

export async function productionDirectGpu(
	input: ProductionDirectInput
): Promise<ProductionDirectResult | null> {
	const device: any = await sharedDevice();
	if (!device) return null;

	const pixels = input.width * input.height;
	const apData = new Float32Array(input.aps.length * 8);
	input.aps.forEach((ap, i) => {
		const offset = i * 8;
		apData[offset] = ap.x;
		apData[offset + 1] = ap.y;
		apData[offset + 2] = ap.referenceDbm;
		apData[offset + 3] = ap.pathLossExponent;
		apData[offset + 4] = ap.verticalGapM;
		apData[offset + 5] = ap.slabLossDb;
	});

	const uniformData = new ArrayBuffer(64);
	const view = new DataView(uniformData);
	view.setUint32(0, input.width, true);
	view.setUint32(4, input.height, true);
	view.setUint32(8, input.aps.length, true);
	view.setUint32(12, input.wallMask?.width ?? 0, true);
	view.setUint32(16, input.wallMask?.height ?? 0, true);
	view.setUint32(20, input.wallMask?.materialMap ? 1 : 0, true);
	view.setFloat32(24, input.wallMask?.stride ?? 2, true);
	view.setFloat32(28, input.wallMask?.originX ?? 0, true);
	view.setFloat32(32, input.wallMask?.originY ?? 0, true);
	view.setFloat32(36, input.texel, true);
	view.setFloat32(40, input.worldUnitsPerMeter, true);
	view.setFloat32(44, input.originX, true);
	view.setFloat32(48, input.originY, true);
	view.setFloat32(52, input.wallMask?.fallbackDb ?? 0, true);
	view.setUint32(56, input.wallMask?.defaultMaterialId ?? 0, true);

	const uniformBuffer = device.createBuffer({
		size: 64,
		usage: USAGE.UNIFORM | USAGE.COPY_DST
	});
	device.queue.writeBuffer(uniformBuffer, 0, uniformData);
	const apBuffer = device.createBuffer({
		size: Math.max(32, apData.byteLength),
		usage: USAGE.STORAGE | USAGE.COPY_DST
	});
	device.queue.writeBuffer(apBuffer, 0, apData);
	const wallPacked = packBytes(input.wallMask?.data ?? null);
	const materialPacked = packBytes(input.wallMask?.materialMap ?? null);
	const materialDb = new Float32Array(input.wallMask?.materialDb ?? []);
	const wallBuffer = device.createBuffer({
		size: Math.max(4, wallPacked.byteLength),
		usage: USAGE.STORAGE | USAGE.COPY_DST
	});
	const materialBuffer = device.createBuffer({
		size: Math.max(4, materialPacked.byteLength),
		usage: USAGE.STORAGE | USAGE.COPY_DST
	});
	const materialDbBuffer = device.createBuffer({
		size: Math.max(4, materialDb.byteLength),
		usage: USAGE.STORAGE | USAGE.COPY_DST
	});
	device.queue.writeBuffer(wallBuffer, 0, wallPacked);
	device.queue.writeBuffer(materialBuffer, 0, materialPacked);
	device.queue.writeBuffer(materialDbBuffer, 0, materialDb);
	const output = device.createBuffer({
		size: pixels * input.aps.length * 4,
		usage: USAGE.STORAGE | USAGE.COPY_SRC
	});
	const read = device.createBuffer({
		size: pixels * input.aps.length * 4,
		usage: USAGE.MAP_READ | USAGE.COPY_DST
	});

	const module = device.createShaderModule({ code: SHADER });
	const pipeline = device.createComputePipeline({
		layout: 'auto',
		compute: { module, entryPoint: 'main' }
	});
	const bindGroup = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: { buffer: apBuffer } },
			{ binding: 2, resource: { buffer: wallBuffer } },
			{ binding: 3, resource: { buffer: materialBuffer } },
			{ binding: 4, resource: { buffer: materialDbBuffer } },
			{ binding: 5, resource: { buffer: output } }
		]
	});

	const started = performance.now();
	const encoder = device.createCommandEncoder();
	const pass = encoder.beginComputePass();
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bindGroup);
	pass.dispatchWorkgroups(
		Math.ceil(input.width / 8),
		Math.ceil(input.height / 8),
		input.aps.length
	);
	pass.end();
	encoder.copyBufferToBuffer(output, 0, read, 0, pixels * input.aps.length * 4);
	device.queue.submit([encoder.finish()]);
	await read.mapAsync(MAP_READ);
	const dbm = new Float32Array(read.getMappedRange().slice(0));
	read.unmap();
	const ms = performance.now() - started;
	read.destroy();
	output.destroy();
	materialDbBuffer.destroy();
	materialBuffer.destroy();
	wallBuffer.destroy();
	apBuffer.destroy();
	uniformBuffer.destroy();
	return { dbm, apCount: input.aps.length, pixels, ms };
}

export interface ProductionProbe {
	supported: boolean;
	reason?: string;
	cpuMs: number;
	gpuMs: number;
	maxAbsErrorDb: number;
	meanAbsErrorDb: number;
	sampleCpu?: number;
	sampleGpu?: number;
}

function syntheticInput(): ProductionDirectInput {
	const size = 256;
	const mask = new Uint8Array(size * size);
	const material = new Uint8Array(size * size);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (Math.abs(x - 64) < 3) {
				mask[y * size + x] = 1;
				material[y * size + x] = 2;
			}
		}
	}
	return {
		width: size,
		height: size,
		originX: 0,
		originY: 0,
		texel: 1,
		worldUnitsPerMeter: 20,
		aps: [
			{ x: 32, y: 48, referenceDbm: 20, pathLossExponent: 4, verticalGapM: 1.5, slabLossDb: 0 },
			{ x: 96, y: 80, referenceDbm: 17, pathLossExponent: 3, verticalGapM: 3, slabLossDb: 6 }
		],
		wallMask: {
			data: mask,
			width: size,
			height: size,
			originX: 0,
			originY: 0,
			materialMap: material,
			materialDb: [0, 4, 9, 0],
			fallbackDb: 5,
			defaultMaterialId: 0,
			stride: 2
		}
	};
}

export async function runProductionProbe(): Promise<ProductionProbe> {
	const input = syntheticInput();
	const cpu = productionDirectCpu(input);
	const gpu = await productionDirectGpu(input);
	if (!gpu) {
		return {
			supported: false,
			reason: 'WebGPU adapter/device unavailable',
			cpuMs: cpu.ms,
			gpuMs: 0,
			maxAbsErrorDb: 0,
			meanAbsErrorDb: 0
		};
	}
	let maxAbsErrorDb = 0;
	let sum = 0;
	for (let i = 0; i < cpu.dbm.length; i++) {
		const error = Math.abs(cpu.dbm[i]! - gpu.dbm[i]!);
		maxAbsErrorDb = Math.max(maxAbsErrorDb, error);
		sum += error;
	}
	return {
		supported: true,
		cpuMs: cpu.ms,
		gpuMs: gpu.ms,
		maxAbsErrorDb,
		meanAbsErrorDb: sum / cpu.dbm.length,
		sampleCpu: cpu.dbm[0],
		sampleGpu: gpu.dbm[0]
	};
}
