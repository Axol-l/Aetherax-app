# WebGPU 直射场原型

这是一版**独立原型**，不替换现有热力图，也不移除 CPU 二级路径。

## 范围

GPU compute shader 只计算直射径：

```text
FSPL = 32.44 + 20 log10(f_MHz) + 20 log10(d_m)
level = AP_power − FSPL − wall_crossings · wall_loss − slab_loss
```

其中：

- `d_m` 是水平距离与 AP/接收点垂直距离组成的三维距离；
- 墙体损耗按射线穿过的墙体像素计数；
- 楼板损耗由调用方一次性给出；
- 每个像素输出最强 AP 的 dBm 和 AP 索引。

反射、绕射、散射仍由 CPU 负责。

## 入口

```ts
import { directFieldCpu, directFieldGpu } from '$lib/gpu/direct-field.js';

const cpu = directFieldCpu(input);
const gpu = await directFieldGpu(input); // 无 WebGPU 时返回 null
```

没有 adapter/device 时调用方应回退 `directFieldCpu`。

## 浏览器探针

打开：

```text
/?gpuProbe=1
```

页面会运行 CPU/GPU 各一次，结果放在：

```js
window.__aetheraxGpuProbe
```

E2E：

```text
GPU_PROBE_CHANNEL=msedge pnpm exec playwright test tests/e2e/gpu-direct.spec.ts
```

不设置 `GPU_PROBE_CHANNEL` 时，无 WebGPU 的 Chromium 会跳过该用例。

## 本轮实测

在 Edge WebGPU、256×256 网格、2 个 AP、合成墙体掩码上：

| 指标 | 数值 |
|---|---:|
| 像素数 | 65,536 |
| CPU 耗时 | 203.4 ms |
| GPU 耗时 | 67.0 ms |
| 最大绝对误差 | 7.6e-6 dB |
| 平均绝对误差 | 1.4e-6 dB |
| AP 索引不一致 | 0 |

GPU 计时从提交 compute 到读回结果，**不包含** adapter/device 初始化、shader 编译和 buffer 创建；这些是一次性或初始化成本。

## 逐 AP 版本

`direct-field-per-ap.ts` 输出：

```text
out[apIndex * pixelCount + pixel] = dBm
```

这样 CPU 可以按 AP 叠加反射/绕射/散射。2 个 AP 的 256×256 逐 AP 实测：

| 指标 | 数值 |
|---|---:|
| 像素×AP | 131,072 |
| CPU 耗时 | 215.2 ms |
| GPU 耗时 | 50.7 ms |
| 最大绝对误差 | 1.5e-5 dB |
| 平均绝对误差 | 1.5e-6 dB |

## 与生产热力图对齐的版本

`production-direct.ts` 使用与生产热力图直射项相同的输入：

- `referenceDbm`（AP 功率 − PL0）；
- `pathLossExponent`，走 `relativePathLossDbAt` 的折断点曲线；
- 栅格墙体掩码 + 材质掩码 + 每材质 dB 表；
- 与 `rayMarchWallAtten` 相同步长的 ray-march；
- 每 AP 固定楼板损耗。

GPU 输出**不含天线**；天线损耗由 CPU 后处理：

```ts
applyProductionAntenna(input, result, apIndex, profile);
```

这样不在 WGSL 里复制 Beam/Aim/Facing 方向图。

256×256、2 AP、带材质墙实测：

| 指标 | 数值 |
|---|---:|
| CPU 耗时 | 57.4 ms |
| GPU 耗时 | 50.6 ms |
| 最大绝对误差 | 9.5e-6 dB |
| 平均绝对误差 | 1.7e-6 dB |

这一版的性能优势不大，因为墙体 ray-march 是逐像素循环；下一步应把墙体/材质上传为 texture，并把每 AP 的循环拆成更多并行 workgroup。

## 已接入热力图的条件

单层热力图在以下条件满足时，会异步用 GPU 直射场替换 CPU 直射项：

- 所有 AP 同频段；
- 没有跨楼层 AP；
- 楼层没有抬高面；
- 有墙体掩码；
- WebGPU adapter/device 可用。

不满足时保留 CPU。GPU 结果到达后触发一次重绘；当前帧仍由 CPU 产生，不会阻塞渲染。

## 接入生产热力图还差

- 跨楼层中庭/楼梯井的逐像素楼板开洞；
- 天线损耗在 CPU 后处理中的相位/复场合并；
- 异步 readback 缓存，避免主线程等待；
- 与现有反射/绕射/散射的逐 AP 复场合并。

## 还不是生产热力图

尚未接入主热力图，因为：

- 主流程需要逐 AP 场，而原型只输出最强 AP；
- 墙体材质表、天线方向图、跨楼层拆分、相位和反射需要与现有模型对齐；
- 需要把 GPU 输出与 CPU 二级路径合并，而不是替换整张图。

下一步可以先在 GPU 中输出逐 AP 直射电平，再由 CPU 叠加反射/绕射/散射。
