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
| CPU 耗时 | 204.7 ms |
| GPU 耗时 | 66.1 ms |
| 最大绝对误差 | 7.6e-6 dB |
| 平均绝对误差 | 1.4e-6 dB |
| AP 索引不一致 | 0 |

GPU 计时从提交 compute 到读回结果，**不包含** adapter/device 初始化、shader 编译和 buffer 创建；这些是一次性或初始化成本。

## 还不是生产热力图

尚未接入主热力图，因为：

- 主流程需要逐 AP 场，而原型只输出最强 AP；
- 墙体材质表、天线方向图、跨楼层拆分、相位和反射需要与现有模型对齐；
- 需要把 GPU 输出与 CPU 二级路径合并，而不是替换整张图。

下一步可以先在 GPU 中输出逐 AP 直射电平，再由 CPU 叠加反射/绕射/散射。
