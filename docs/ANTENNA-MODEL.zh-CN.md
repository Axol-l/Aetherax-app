# 天线模型升级方案

## 1. 范围

本轮把天线从“单一垂直波束”升级为可分别描述水平面和垂直面的规划模型，并支持：

- 水平波束宽度；
- 垂直波束宽度；
- 垂直指向；
- 水平朝向；
- 单线极化（垂直/水平）；
- 双线极化（V+H，先做功率和）。

本轮不做：

- 圆极化；
- 双端口 MIMO 相关矩阵；
- 厂商实测三维方向图导入；
- 独立的天线增益校准。

## 2. 功率语义

`AP.power` 目前直接使用型号表里的 `maxTxPower`，而厂商文件注明这些值是**传导功率（conducted）**。当前模型没有单独的 `gainDbi` 项，因此：

- 方向图只施加相对峰值的方向图损耗；
- 更窄的波束不会自动提高主瓣峰值；
- 绝对电平没有加天线增益，属于规划近似。

若以后要严格按“传导功率 + 天线增益 + 线损”计算，应新增 `gainDbi` / `cableLossDb`，不能直接把现有 `power` 改叫 EIRP。

这是当前的已知限制，也是保持旧工程数值连续的取舍。

## 3. 数据模型

### 3.1 AP 字段

保留 `beamwidthDeg` 作为**垂直波束宽度**的存储名，避免大规模迁移；新增：

```ts
horizontalBeamwidthDeg: number; // 水平面 -3 dB 宽度
polarizationMode: 'single' | 'dual'; // 双极化先表示 V+H 等功率
```

已有字段：

```ts
beamwidthDeg: number; // 垂直波束宽度
aimDeg: number; // 垂直指向，向下为正
facingDeg: number; // 水平朝向
polarizationAngleDeg: number; // 单极化角，0=V，90=H
```

默认值：

| 安装方式 | 垂直波束 | 水平波束 | Aim |
|---|---:|---:|---:|
| ceiling | 2.4G 120°，5/6G 60° | 360° | 30° |
| wall | 60° | 90° | 0° |
| floor | 60° | 360° | 0° |

### 3.2 型号预设

`ApBandSpec` 增加可选：

```ts
horizontalBeamwidthDeg?: number;
```

`recommendedAntenna()` 返回：

```ts
{
  beamwidthDeg, // 垂直
  horizontalBeamwidthDeg,
  aimDeg
}
```

型号没有显式数据时按上表默认。

### 3.3 极化

第一版只支持：

```ts
polarizationMode: 'single' | 'dual';
polarizationAngleDeg: number; // single 时有效
```

- `single`：一个线极化源，按 `polarizationAngleDeg` 投影到 V/H；
- `dual`：V 和 H 两个等功率端口，各占一半功率，按功率和合成。

双极化不表示 MIMO 流数或相关矩阵。

## 4. 传播模型

### 4.1 方向图

使用可分离的水平和垂直切面：

```text
L_ant = L_vertical(angle, aim, beamV)
      + L_horizontal(bearing, facing, beamH)
```

- `beamH = 360` 或 `>= 180`：水平无方向性，损耗为 0；
- `beamV = 180`：垂直无方向性；
- `facingDeg` 对所有安装方式都参与计算，但水平全向时不影响结果。

### 4.2 单极化

沿用现有 V/H 复场和接收极化投影：

```text
E_rx = E_V·cosθ_rx + E_H·sinθ_rx
```

### 4.3 双极化（功率和）

每个端口功率为 `power - 3 dB`，分别按 V 和 H 发射：

```text
P_ap = P_V + P_H
```

接收端仍按自己的极化角投影；因此单极化接收机会只收到双极化 AP 的一个端口，这是有意保留的物理行为。

## 5. SVG 图

AP 设置栏的图拆成两个切面：

1. **侧视**：垂直波束宽度、Aim、安装高度、地面覆盖；
2. **俯视**：水平波束宽度、Facing；水平 360° 时画整圆，否则画扇形。

极化标记：

- single：一条带角度的双箭头；
- dual：V+H 十字箭头。

图上显示：

```text
Beam V / Beam H / Aim / Facing / Pol
```

## 6. 兼容与迁移

旧工程：

- `beamwidthDeg` 继续作为垂直波束；
- 缺省 `horizontalBeamwidthDeg` 按安装方式补；
- 缺省 `polarizationMode` 为 `single`；
- 旧 `polarizationAngleDeg` 保留。

缓存键：

- `antennaSignature` 加入水平波束和极化模式；
- 热力图、优化器、导出都需要带上新字段。

## 7. 验收

- 水平 360°/垂直 60° 的吸顶 AP 与旧模型在水平面一致；
- 水平 75°/垂直 55° 的定向 AP 与水平 150°/垂直 15° 的板状 AP 产生明显不同的平面覆盖；
- 双极化 AP 在单极化接收端上约损失 3 dB；
- 旧工程加载后视觉和数值不发生跳变；
- `pnpm check`、`pnpm test`、e2e、桌面构建通过。
