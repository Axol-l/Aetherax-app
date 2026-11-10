/**
 * WebGPU 直射场的逐 AP 版本。
 *
 * 输出 `apIndex * pixelCount + pixel` 的 dBm，CPU 侧可再叠加反射/绕射/散射。
 * 仍是原型：不接入生产热力图。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DirectFieldInput } from './direct-field.js';
import { syntheticDirectFieldInput } from './direct-field.js';

export interface DirectFieldPerApResult {
	dbm: Float32Array;
	apCount: number;
	pixels: number;
	ms: number;
}

const BUFFER_USAGE = {
	COPY_SRC: 4,
	COPY_DST: 8,
	UNIFORM: 64,
	STORAGE: 128,
	MAP_READ: 1
};
const MAP_MODE_READ = 1;

const WALL_THRESHOLD = 128;

function wallAt(
	mask: NonNullable<DirectFieldInput['wallMask']>,
	x: number,
	y: number
): boolean {
	const px = Math.floor(x - mask.originX);
	const py = Math.floor(y - mask.originY);
	if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return false;
	return mask.data[py * mask.width + px]! >= WALL_THRESHOLD;
}

function wallCrossings(
	mask: NonNullable<DirectFieldInput['wallMask']>,
	ax: number,
	ay: number,
	bx: number,
	by: number
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const length = Math.hypot(dx, dy);
	if (!(length > 0)) return 0;
	const steps = Math.max(1, Math.ceil(length / 0.75));
	let previous = wallAt(mask, ax, ay);
	let count = 0;
	for (let step = 1; step <= steps; step++) {
		const t = step / steps;
		const wall = wallAt(mask, ax + dx * t, ay + dy * t);
		if (wall && !previous) count++;
		previous = wall;
	}
	return count;
}

/** CPU 参考：每个 AP 一张电平图。 */
export function directFieldPerApCpu(input: DirectFieldInput): DirectFieldPerApResult {
	const started = performance.now();
	const pixels = input.width * input.height;
	const dbm = new Float32Array(pixels * input.aps.length);
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
				const fspl = 32.44 + 20 * Math.log10(ap.frequencyMhz) + 20 * Math.log10(distanceM);
				const wallLoss = input.wallMask
					? wallCrossings(input.wallMask, ap.x, ap.y, wx, wy) * input.wallMask.wallLossDb
					: 0;
				dbm[offset + py * input.width + px] =
					ap.powerDbm - fspl - wallLoss - ap.slabLossDb;
			}
		}
	}
	return { dbm, apCount: input.aps.length, pixels, ms: performance.now() - started };
}

const SHADER_PER_AP = /* wgsl */ `
struct Uniforms {
	width: u32,
	height: u32,
	apCount: u32,
	maskWidth: u32,
	maskHeight: u32,
	maskOriginX: f32,
	maskOriginY: f32,
	texel: f32,
	worldUnitsPerMeter: f32,
	wallLossDb: f32,
	originX: f32,
	originY: f32,
	pad0: f32,
	pad1: f32,
};

struct Ap {
	x: f32,
	y: f32,
	power: f32,
	frequencyMhz: f32,
	verticalGapM: f32,
	slabLossDb: f32,
	wallLossDb: f32,
	pad: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> aps: array<Ap>;
@group(0) @binding(2) var<storage, read> maskBits: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<f32>;

fn wallAt(x: f32, y: f32) -> bool {
	if (u.maskWidth == 0u || u.maskHeight == 0u) { return false; }
	let px = i32(floor(x - u.maskOriginX));
	let py = i32(floor(y - u.maskOriginY));
	if (px < 0 || py < 0 || px >= i32(u.maskWidth) || py >= i32(u.maskHeight)) { return false; }
	let index = u32(py) * u.maskWidth + u32(px);
	let bits = maskBits[index >> 2u];
	let value = (bits >> ((index & 3u) * 8u)) & 255u;
	return value >= 128u;
}

fn wallCrossings(ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
	if (u.maskWidth == 0u || u.maskHeight == 0u) { return 0.0; }
	let dx = bx - ax;
	let dy = by - ay;
	let length = sqrt(dx * dx + dy * dy);
	if (length <= 0.0) { return 0.0; }
	let steps = max(1u, u32(ceil(length / 0.75)));
	var previous = wallAt(ax, ay);
	var count = 0u;
	for (var step = 1u; step <= steps; step = step + 1u) {
		let t = f32(step) / f32(steps);
		let wall = wallAt(ax + dx * t, ay + dy * t);
		if (wall && !previous) { count = count + 1u; }
		previous = wall;
	}
	return f32(count);
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
	let fspl = 32.44 + 20.0 * log2(ap.frequencyMhz) / log2(10.0) + 20.0 * log2(distanceM) / log2(10.0);
	let wallLoss = wallCrossings(ap.x, ap.y, wx, wy) * ap.wallLossDb;
	let level = ap.power - fspl - wallLoss - ap.slabLossDb;
	let index = gid.z * u.width * u.height + gid.y * u.width + gid.x;
	out[index] = level;
}
`;

export async function directFieldPerApGpu(
	input: DirectFieldInput
): Promise<DirectFieldPerApResult | null> {
	const gpu = (navigator as any).gpu;
	if (!gpu) return null;
	const adapter = await gpu.requestAdapter();
	if (!adapter) return null;
	const device: any = await adapter.requestDevice();
	if (!device) return null;

	const pixels = input.width * input.height;
	const apData = new Float32Array(input.aps.length * 8);
	input.aps.forEach((ap, i) => {
		const offset = i * 8;
		apData[offset] = ap.x;
		apData[offset + 1] = ap.y;
		apData[offset + 2] = ap.powerDbm;
		apData[offset + 3] = ap.frequencyMhz;
		apData[offset + 4] = ap.verticalGapM;
		apData[offset + 5] = ap.slabLossDb;
		apData[offset + 6] = input.wallMask?.wallLossDb ?? 0;
	});

	const uniform = new ArrayBuffer(64);
	const view = new DataView(uniform);
	view.setUint32(0, input.width, true);
	view.setUint32(4, input.height, true);
	view.setUint32(8, input.aps.length, true);
	view.setUint32(12, input.wallMask?.width ?? 0, true);
	view.setUint32(16, input.wallMask?.height ?? 0, true);
	view.setFloat32(20, input.wallMask?.originX ?? 0, true);
	view.setFloat32(24, input.wallMask?.originY ?? 0, true);
	view.setFloat32(28, input.texel, true);
	view.setFloat32(32, input.worldUnitsPerMeter, true);
	view.setFloat32(36, input.wallMask?.wallLossDb ?? 0, true);
	view.setFloat32(40, input.originX, true);
	view.setFloat32(44, input.originY, true);

	const uniformBuffer = device.createBuffer({
		size: 64,
		usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST
	});
	device.queue.writeBuffer(uniformBuffer, 0, uniform);
	const apBuffer = device.createBuffer({
		size: Math.max(32, apData.byteLength),
		usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST
	});
	device.queue.writeBuffer(apBuffer, 0, apData);

	const maskData = input.wallMask?.data;
	let packed = new Uint32Array(1);
	if (maskData && maskData.length > 0) {
		packed = new Uint32Array(Math.ceil(maskData.length / 4));
		for (let i = 0; i < maskData.length; i++) {
			const word = i >> 2;
			packed[word] = (packed[word] ?? 0) | ((maskData[i] ?? 0) << ((i & 3) * 8));
		}
	}
	const maskBuffer = device.createBuffer({
		size: Math.max(4, packed.byteLength),
		usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST
	});
	device.queue.writeBuffer(maskBuffer, 0, packed);
	const output = device.createBuffer({
		size: pixels * input.aps.length * 4,
		usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC
	});
	const read = device.createBuffer({
		size: pixels * input.aps.length * 4,
		usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST
	});

	const module = device.createShaderModule({ code: SHADER_PER_AP });
	const pipeline = device.createComputePipeline({
		layout: 'auto',
		compute: { module, entryPoint: 'main' }
	});
	const bindGroup = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: { buffer: apBuffer } },
			{ binding: 2, resource: { buffer: maskBuffer } },
			{ binding: 3, resource: { buffer: output } }
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
	await read.mapAsync(MAP_MODE_READ);
	const dbm = new Float32Array(read.getMappedRange().slice(0));
	read.unmap();
	const ms = performance.now() - started;
	read.destroy();
	output.destroy();
	maskBuffer.destroy();
	apBuffer.destroy();
	uniformBuffer.destroy();
	return { dbm, apCount: input.aps.length, pixels, ms };
}

export interface GpuPerApProbe {
	supported: boolean;
	reason?: string;
	cpuMs: number;
	gpuMs: number;
	pixels: number;
	apCount: number;
	maxAbsErrorDb: number;
	meanAbsErrorDb: number;
}

export async function runGpuPerApProbe(): Promise<GpuPerApProbe> {
	const input = syntheticDirectFieldInput();
	const cpu = directFieldPerApCpu(input);
	const gpu = await directFieldPerApGpu(input);
	if (!gpu) {
		return {
			supported: false,
			reason: 'WebGPU adapter/device unavailable',
			cpuMs: cpu.ms,
			gpuMs: 0,
			pixels: cpu.pixels,
			apCount: cpu.apCount,
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
		pixels: cpu.pixels,
		apCount: cpu.apCount,
		maxAbsErrorDb,
		meanAbsErrorDb: sum / cpu.dbm.length
	};
}
