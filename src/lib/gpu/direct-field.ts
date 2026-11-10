/**
 * WebGPU 直射场原型。
 *
 * 只计算直射径：自由空间损耗 + 墙体穿越损耗 + 楼板附加损耗。
 * 反射、绕射、散射仍由 CPU 处理；这里不改动现有热力图，只做数值/性能对照。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DirectFieldAp {
	x: number;
	y: number;
	powerDbm: number;
	frequencyMhz: number;
	/** 接收点与 AP 的垂直距离，米。 */
	verticalGapM: number;
	/** 跨楼层时一次性计入的楼板损耗，dB。 */
	slabLossDb: number;
}

export interface DirectFieldMask {
	data: Uint8Array;
	width: number;
	height: number;
	originX: number;
	originY: number;
	/** 每穿过一面墙的损耗，dB。 */
	wallLossDb: number;
}

export interface DirectFieldInput {
	width: number;
	height: number;
	originX: number;
	originY: number;
	/** 每个像素对应的世界单位。 */
	texel: number;
	worldUnitsPerMeter: number;
	aps: DirectFieldAp[];
	wallMask?: DirectFieldMask | null;
}

export interface DirectFieldResult {
	dbm: Float32Array;
	apIndex: Int32Array;
	ms: number;
}

const WALL_THRESHOLD = 128;
const BUFFER_USAGE = {
	MAP_READ: 1,
	COPY_SRC: 4,
	COPY_DST: 8,
	UNIFORM: 64,
	STORAGE: 128
};
const MAP_MODE_READ = 1;

function wallAt(mask: DirectFieldMask, x: number, y: number): boolean {
	const px = Math.floor(x - mask.originX);
	const py = Math.floor(y - mask.originY);
	if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return false;
	return mask.data[py * mask.width + px]! >= WALL_THRESHOLD;
}

function wallCrossings(mask: DirectFieldMask, ax: number, ay: number, bx: number, by: number): number {
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

/** CPU 参考实现；与 WGSL 保持同一套公式。 */
export function directFieldCpu(input: DirectFieldInput): DirectFieldResult {
	const started = performance.now();
	const dbm = new Float32Array(input.width * input.height).fill(-Infinity);
	const apIndex = new Int32Array(input.width * input.height).fill(-1);
	const aps = input.aps;
	for (let py = 0; py < input.height; py++) {
		const wy = input.originY + (py + 0.5) * input.texel;
		for (let px = 0; px < input.width; px++) {
			const wx = input.originX + (px + 0.5) * input.texel;
			let best = -Infinity;
			let bestAp = -1;
			for (let i = 0; i < aps.length; i++) {
				const ap = aps[i]!;
				const dx = wx - ap.x;
				const dy = wy - ap.y;
				const horizontalM = Math.hypot(dx, dy) / input.worldUnitsPerMeter;
				const distanceM = Math.max(0.1, Math.hypot(horizontalM, ap.verticalGapM));
				const fspl = 32.44 + 20 * Math.log10(ap.frequencyMhz) + 20 * Math.log10(distanceM);
				const wallLoss = input.wallMask
					? wallCrossings(input.wallMask, ap.x, ap.y, wx, wy) * input.wallMask.wallLossDb
					: 0;
				const level = ap.powerDbm - fspl - wallLoss - ap.slabLossDb;
				if (level > best) {
					best = level;
					bestAp = i;
				}
			}
			const index = py * input.width + px;
			dbm[index] = best;
			apIndex[index] = bestAp;
		}
	}
	return { dbm, apIndex, ms: performance.now() - started };
}

const SHADER = /* wgsl */ `
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
@group(0) @binding(3) var<storage, read_write> out: array<vec2<f32>>;

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

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	if (gid.x >= u.width || gid.y >= u.height) { return; }
	let wx = u.originX + (f32(gid.x) + 0.5) * u.texel;
	let wy = u.originY + (f32(gid.y) + 0.5) * u.texel;
	var best = -1.0e30;
	var bestAp = -1.0;
	for (var i = 0u; i < u.apCount; i = i + 1u) {
		let ap = aps[i];
		let dx = wx - ap.x;
		let dy = wy - ap.y;
		let horizontalM = sqrt(dx * dx + dy * dy) / u.worldUnitsPerMeter;
		let vertical = ap.verticalGapM;
		let distanceM = max(0.1, sqrt(horizontalM * horizontalM + vertical * vertical));
		let fspl = 32.44 + 20.0 * log2(ap.frequencyMhz) / log2(10.0) + 20.0 * log2(distanceM) / log2(10.0);
		let wallLoss = wallCrossings(ap.x, ap.y, wx, wy) * ap.wallLossDb;
		let level = ap.power - fspl - wallLoss - ap.slabLossDb;
		if (level > best) {
			best = level;
			bestAp = f32(i);
		}
	}
	let index = gid.y * u.width + gid.x;
	out[index] = vec2<f32>(best, bestAp);
}
`;

/** 运行 GPU 版本。没有 WebGPU 时返回 null，调用方应回退 CPU。 */
export async function directFieldGpu(input: DirectFieldInput): Promise<DirectFieldResult | null> {
	const gpu = (navigator as any).gpu;
	if (!gpu) return null;
	const adapter = await gpu.requestAdapter();
	if (!adapter) return null;
	const device: any = await adapter.requestDevice();
	if (!device) return null;

	const pixelCount = input.width * input.height;
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

	const uniformBuffer = device.createBuffer({
		size: 64,
		usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST
	});
	const uniformData = new ArrayBuffer(64);
	const view = new DataView(uniformData);
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
	device.queue.writeBuffer(uniformBuffer, 0, uniformData);

	const apBuffer = device.createBuffer({
		size: Math.max(32, apData.byteLength),
		usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST
	});
	device.queue.writeBuffer(apBuffer, 0, apData);

	let packedMask = new Uint32Array(1);
	const maskData = input.wallMask?.data;
	if (maskData && maskData.length > 0) {
		packedMask = new Uint32Array(Math.ceil(maskData.length / 4));
		for (let i = 0; i < maskData.length; i++) {
			const word = i >> 2;
			packedMask[word] = (packedMask[word] ?? 0) | ((maskData[i] ?? 0) << ((i & 3) * 8));
		}
	}
	const maskBuffer = device.createBuffer({
		size: Math.max(4, packedMask.byteLength),
		usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST
	});
	device.queue.writeBuffer(maskBuffer, 0, packedMask);

	const outputBuffer = device.createBuffer({
		size: pixelCount * 2 * 4,
		usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC
	});
	const readBuffer = device.createBuffer({
		size: pixelCount * 2 * 4,
		usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST
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
			{ binding: 2, resource: { buffer: maskBuffer } },
			{ binding: 3, resource: { buffer: outputBuffer } }
		]
	});

	const started = performance.now();
	const encoder = device.createCommandEncoder();
	const pass = encoder.beginComputePass();
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bindGroup);
	pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8));
	pass.end();
	encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, pixelCount * 2 * 4);
	device.queue.submit([encoder.finish()]);
	await readBuffer.mapAsync(MAP_MODE_READ);
	const data = new Float32Array(readBuffer.getMappedRange().slice(0));
	readBuffer.unmap();

	const dbm = new Float32Array(pixelCount);
	const apIndex = new Int32Array(pixelCount);
	for (let i = 0; i < pixelCount; i++) {
		dbm[i] = data[i * 2]!;
		apIndex[i] = Math.round(data[i * 2 + 1]!);
	}
	const elapsed = performance.now() - started;
	readBuffer.destroy();
	outputBuffer.destroy();
	maskBuffer.destroy();
	apBuffer.destroy();
	uniformBuffer.destroy();
	return { dbm, apIndex, ms: elapsed };
}

export interface GpuDirectProbe {
	supported: boolean;
	reason?: string;
	cpuMs: number;
	gpuMs: number;
	pixels: number;
	maxAbsErrorDb: number;
	meanAbsErrorDb: number;
	mismatchedAp: number;
}

function syntheticInput(): DirectFieldInput {
	const size = 256;
	const mask = new Uint8Array(size * size);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (Math.abs(x - 128) < 2 || Math.abs(y - 96) < 2) mask[y * size + x] = 255;
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
			{ x: 64, y: 64, powerDbm: 20, frequencyMhz: 5180, verticalGapM: 1.5, slabLossDb: 0 },
			{ x: 192, y: 192, powerDbm: 17, frequencyMhz: 2437, verticalGapM: 3.5, slabLossDb: 12 }
		],
		wallMask: {
			data: mask,
			width: size,
			height: size,
			originX: 0,
			originY: 0,
			wallLossDb: 6
		}
	};
}

export async function runGpuDirectProbe(): Promise<GpuDirectProbe> {
	const input = syntheticInput();
	const cpu = directFieldCpu(input);
	const gpu = await directFieldGpu(input);
	if (!gpu) {
		return {
			supported: false,
			reason: 'WebGPU adapter/device unavailable',
			cpuMs: cpu.ms,
			gpuMs: 0,
			pixels: input.width * input.height,
			maxAbsErrorDb: 0,
			meanAbsErrorDb: 0,
			mismatchedAp: 0
		};
	}
	let maxAbsErrorDb = 0;
	let sumError = 0;
	let mismatchedAp = 0;
	for (let i = 0; i < cpu.dbm.length; i++) {
		const error = Math.abs(cpu.dbm[i]! - gpu.dbm[i]!);
		maxAbsErrorDb = Math.max(maxAbsErrorDb, error);
		sumError += error;
		if (cpu.apIndex[i] !== gpu.apIndex[i]) mismatchedAp++;
	}
	return {
		supported: true,
		cpuMs: cpu.ms,
		gpuMs: gpu.ms,
		pixels: input.width * input.height,
		maxAbsErrorDb,
		meanAbsErrorDb: sumError / cpu.dbm.length,
		mismatchedAp
	};
}
