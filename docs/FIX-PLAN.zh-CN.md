# Aetherax 架构修复计划

> 这份文档回答一个问题：**代码架构里还有哪些地方值得改，每条到底是怎么回事、怎么改、改完怎么知道改对了。**
>
> 它不是"代码写得不好"的清单。现状是健康的：`src/` 里 0 个 `any`、0 个 `@ts-ignore`、0 个 TODO，全仓只有 51 个 `$effect`，50 个单测 + 29 个 e2e，而且大文件在稳定缩小（`CanvasView` 3384 → 2247 行，`optimizer.svelte.ts` 2047 → 918）。下面的每一条，都是**已经在正确方向上的工作还没走完的那一步**。
>
> **进度**：19 条里 **17 条已落地**（01–04、06–18，含 OCR 删除与两处死代码清理），**16 条部分完成**（结构性危害已消，effect 收拢未做），**19 条未做**（领域数据表搬迁），**05 条受环境限制**（CSP，需要能 `tauri build` 的机器）。门禁：`pnpm check / test / lint / build / test:e2e / test:measure` 全绿（637 单测 + 106 e2e + 16 测量场景）。**还没做完的小事与顺序，见 §6b。**

---

## 0. 先把黑话翻译成人话

这份代码里有 5 个概念反复出现，看不懂往往卡在这里：

| 词 | 在这份代码里指什么 | 一句话理解 |
| --- | --- | --- |
| **掩膜 mask** | `floor.wallMask`：一张 PNG，把"墙"涂成 1、"空"涂成 0 的位图 | 墙体模型是线段，但算法要的是像素图，所以每次改墙都重新栅格化一张 |
| **origin（原点）** | 掩膜贴在平面图上的偏移量 | 掩膜是"局部坐标"，origin 是"这张图在世界坐标里从哪儿开始" |
| **缓存键 cache key** | 判断"上次算的结果还能不能直接用"的那串东西 | 键里**没写进去**的东西，改了也不会触发重算 —— 这是本仓库最大一类 bug 的来源 |
| **identity（对象身份）** | `===` 相等，不是内容相等 | 缓存用"这个对象还是不是原来那个"来判断要不要重算；就地改内容 = 缓存以为没变 |
| **$effect** | Svelte 5 的自动重跑块 | 里面读到的状态变了它自己再跑一遍。它**靠读到了什么**来建立依赖，函数第一行的 `if (!x) return` 读不到东西 |

还有两个词在这份文档里出现得很多：

- **所有者（owner）**：同一个事实只允许有一个地方说了算。两个地方都能改它 = 一定有一天两边不一致。
- **worker**：跑在后台线程里的那份代码（`optimizer-worker.ts`），不能访问 DOM，和主线程只靠 `postMessage` 通信。

---

## 1. 总览

| # | 问题 | 严重度 | 成本 | 风险（改错了会怎样） |
| --- | --- | --- | --- | --- |
| 01 | 关窗丢最后 5–6.5 秒的编辑 | 高 | 半天 | 低 |
| 02 | 每层底图的存储 key 没有主人 | 高 | 半天 | 低 |
| 03 | "已保存"可能在撒谎 | 高 | 半天 | 低 |
| 04 | 一个渲染异常让画布永久冻结 | 高 | 10 行 | 极低 |
| 05 | 安全面：CSP 还是关着的（OCR 已删，只剩 CSP） | 中 | 半天 | 中（要改打包） |
| 06 | 掩膜换了原点，缓存以为什么都没变 | 高 | 20 行 | 低 |
| 07 | "建筑内部/房间编号"被算了两遍 | 高 | 2 天 | 中 |
| 08 | 覆盖率被当项目数据存，且无人失效 | 中 | 1 天 | 中 |
| 09 | 撤销没有"文档边界" | 高 | 3 行 | 极低 |
| 10 | 墙衰减是死参数 | 中 | 半天 | 低 |
| 11 | Cancel 是装饰性的 | 高 | 1 天 | 低 |
| 12 | worker 协议分不清两次请求 | 高 | 1 天 | 中 |
| 13 | "三套评估器一套墙损耗"只在慢路径成立 | 中 | 2–3 天 | 高（会改数字） |
| 14 | 每次 restart 重发全部几何 | 中 | 1 天 | 中 |
| 15 | 7 个互斥模式写成 7 个 boolean | 中 | 半天 | 低 |
| 16 | CanvasView 手写同步 15 个图层 | 中 | 2–3 天 | 中 |
| 17 | 渲染循环存在三份 | 低 | 1 天 | 中 |
| 18 | `wall-detect.ts` 一文件三用，拖进重依赖 | 中 | 半天 | 低 |
| 19 | 领域数据表住在 `canvas/` 里 | 中 | 半天 | 低 |

**建议顺序**：01–04 → 06/09/10 → 07/08 → 11/12 → 15/16 → 13/14/17/18/19（有测量再动）。

---

## 2. P0：数据安全（先修，全是安全网）

### 01 · 关窗会丢最后 5–6.5 秒的编辑

**位置**：`src/lib/state/persistence.svelte.ts`、`src-tauri/src/lib.rs`

**用户看到的现象**：画完最后一笔，立刻关窗口。再打开，最后一笔没了。

**机制**：
自动存盘不是每次编辑都写，而是"最后一次编辑之后 5 秒"才写：

```ts
// persistence.svelte.ts:35
const SAVE_DELAY = 5000;

// persistence.svelte.ts:278-295
saveTimeout = setTimeout(() => {
  saveTimeout = null;
  const run = () => void saveToStorage();
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
  else run();
}, SAVE_DELAY);
```

也就是：5 秒计时 + 最多 1.5 秒等空闲帧 = 关窗前 **6.5 秒内的编辑一个字都没写**。

而全仓**没有任何一处**接管"要关了"这件事：没有 `beforeunload`、没有 `pagehide`、没有 `visibilitychange`；Rust 侧 `lib.rs` 只有 16 行，没有 `onCloseRequested`。窗口一关，webview 直接销毁，那个还没到点的 `setTimeout` 永远不会执行。

**这不是"浏览器应用的正常行为"**——浏览器里用户还能靠"页面没关"等它存完；桌面应用里点 ✕ 就是立刻销毁。

**怎么改**（两处，任选其一或都做）：

1. 便宜版：在 `persistence.svelte.ts` 里加一个"立刻写"的同步路径，并挂到 `pagehide`：

```ts
// 注意：saveToStorage 是 async 且走 IndexedDB，页面卸载时不一定跑得完。
// 真正可靠的兜底是同步写 localStorage，哪怕之后还要写 IndexedDB。
addEventListener('pagehide', () => {
  if (!pendingEditSinceLastSave) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toDocument({ floorCoverage: floorCoverageState })));
});
```

2. 正确版：在 Tauri 侧拦截关窗，写完再关：

```rust
// src-tauri/src/lib.rs
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        // 让前端 flush，再 destroy
        let _ = window.emit("flush-before-close", ());
    }
})
```

前端监听 `flush-before-close` → `await saveNow()` → 调 `window.destroy()`。

**怎么验证**：e2e 里"改一笔 → 立刻关窗 → 重开 → 断言还在"。手动版：改一笔，0.5 秒内按 ✕，重开看还在不在。

**成本**：便宜版 15 行；正确版需要一条 Tauri command + 前端监听，约 60 行。

---

### 02 · 每层底图的存储 key 没有主人

**位置**：`src/lib/state/persistence.svelte.ts`

**用户看到的现象**：删掉一层，磁盘没变干净；换成 IndexedDB 之后（如果切了），所有底图消失。

**机制**：
一层底图存在自己的 key 里，key 是手拼的字符串：

```ts
// persistence.svelte.ts:121（写）
const key = `${FLOORPLAN_KEY}:${floor.id}`;

// persistence.svelte.ts:212（读）
const perFloor = await store.read(`${FLOORPLAN_KEY}:${floor.id}`);

// persistence.svelte.ts:234（清）
await store.remove(`${FLOORPLAN_KEY}:${floor.id}`);
```

三处手拼，**没有第四个地方知道这个规则**：

- `migrateInto(store, [STORAGE_KEY, FLOORPLAN_KEY])`（:175）只搬这两个固定 key，**从来不会搬 `floorplan:<id>`**。所以一旦把 `BACKEND` 从 `localstorage` 切成 `indexeddb`（:152），项目文档过去了，底图全留在旧后端 → 用户看到一层空白平面图。
- 删楼层时没人删这个 key（`removeFloor` 完全不碰存储）。底图是几百 KB 到几 MB 的 PNG，删掉的层永远占着 5 MB 配额。
- 旧前缀 `deconflict:` 的迁移是"复制、不删除"（:48-65），而新的 prefixed key 还在，于是**同一张底图在 localStorage 里存两份**——本来就快满的 5 MB 被吃掉一半。

**怎么改**：

```ts
// 一个函数，所有人用
const floorplanKey = (floorId: string) => `${FLOORPLAN_KEY}:${floorId}`;

// 迁移与清理改成按前缀枚举，而不是按固定 key
async function deleteFloorplanKeys(store: KeyValueStore, keep?: string) {
  for (const key of await store.keys()) {
    if (!key.startsWith(`${FLOORPLAN_KEY}:`)) continue;
    if (keep && key === keep) continue;
    await store.remove(key);
  }
}
```

然后在 `removeFloor` 里调一次，旧的 `deconflict:` key 在复制成功、`migrateInto` 返回之后删除。

**怎么验证**：单测——写两层底图 → 删一层 → 断言只剩一个 `floorplan:` key；迁移测试——localStorage 里放一个 `floorplan:x` → 切到 IndexedDB → 断言读得到。

**成本**：约 60 行，其中一半是测试。

---

### 03 · "已保存"可能在撒谎

**位置**：`persistence.svelte.ts:105-138`

**用户看到的现象**：按 Ctrl+S，弹"Project saved"。下次打开，那一层的底图没了。

**机制**：
一次保存其实是两次写：项目文档（小、同步完成）+ 每层底图（大、异步）。但"保存成功"的判定只看第一次：

```ts
await store.write(STORAGE_KEY, json);      // ← 文档写完
persistenceState.lastSaved = new Date();   // ← 就宣布成功了
appState.storageNotice = null;
```

底图是另一条完全独立的路径，而且是在图片 `onload` 回调里 fire-and-forget：

```ts
img.onload = () => {
  ...
  void store.write(key, canvas.toDataURL('image/png')).catch(() => {
    // too large: the project document is what has to land
  });
};
```

这个 `.catch` 是空的——写失败了没有任何人知道，包括用户。而 `saveNow()` 的"Project saved"提示（:254）在文档写完时就已经弹出来了，那时底图可能还在编码。

**怎么改**：把底图写进同一次保存的 `Promise.all`，失败就让它算失败：

```ts
async function saveToStorage() {
  const doc = JSON.stringify(toDocument(...));
  const images = await Promise.all(floors.map(async (f) => {
    const key = floorplanKey(f.id);
    const png = await encodeFloorplan(f);
    return png ? store.write(key, png) : null;
  }));
  // 任何一个失败都进 catch，走同一句 storageNotice
}
```

顺带：`saveNow` 的提示应该在 `await saveToStorage()` 之后弹（现在已经是了），但 `lastSaved` 也要跟着这套一起。

**怎么验证**：单测——让 `store.write` 对 `floorplan:*` 抛错，断言 `appState.storageNotice` 非空；反向：正常路径下 `lastSaved` 只在两次写都完成后才变。

**成本**：约 40 行。

---

### 04 · 一个渲染异常让画布永久冻结

**位置**：`src/lib/canvas/engine.ts:64-72`

**用户看到的现象**：某些操作之后画面完全不动了，但界面其他部分（侧栏、按钮）还是好的。点哪儿都没反应，也不会报错。

**机制**：

```ts
markDirty(): void {
  this.dirty = true;
  if (!this.running) {          // ← running 为 true 就什么都不做
    this.running = true;
    this.animFrameId = requestAnimationFrame(this.loop);
  }
}

private loop = (): void => {
  if (this.dirty) {
    this.render();                    // ← 这里抛异常
    this.dirty = false;               // ← 不执行
    this.animFrameId = requestAnimationFrame(this.loop);  // ← 不执行
  } else {
    this.running = false;
  }
};
```

任何一个图层的 `render()` 抛异常：`requestAnimationFrame` 链断掉、`dirty` 卡在 `true`、`running` 却还是 `true`。之后**每一次** `markDirty()` 都因为 `if (!this.running)` 直接返回 —— 永远不再出帧。异常本身只在控制台出现一次，用户什么提示都看不到。

**怎么改**：

```ts
private loop = (): void => {
  try {
    if (this.dirty) {
      this.dirty = false;
      this.render();
    }
  } catch (err) {
    console.error('[canvas] render failed', err);
  } finally {
    if (this.dirty) this.animFrameId = requestAnimationFrame(this.loop);
    else this.running = false;
  }
};
```

再加一个"这一帧抛过异常"的计数器，超过阈值就停帧并给用户一条 notice（`appState` 里已经有 notice 机制），而不是静默转圈。

**怎么验证**：单测——往 engine 里塞一个 `render()` 必抛的假 layer，`markDirty()` 两次，断言 rAF 被再次调用且第二次 render 真的执行了。

**成本**：10 行。

---

### 05 · 安全面：CSP 还是关着的（OCR 已删除，这条现在只剩 CSP）

**位置**：`src-tauri/tauri.conf.json`

**现象**：`"security": { "csp": null }`。CSP 是 webview 里唯一能拦"注入进来的脚本"的机制，打包的应用把它关掉了。

**这条已经比原来简单**：原本它和 OCR 绑在一起——Tesseract 首次使用要从 CDN 拉 worker 脚本、wasm core 和 `eng.traineddata`，所以开 CSP 就得先把那三个资源白名单写进去（等于永久依赖那些域名）。**OCR 已经删除**（见 `wall-detect.ts` 顶部的注释），应用现在没有任何网络请求，于是：

- 不用自托管任何资产；
- 不用为任何域名开口子；
- CSP 可以直接写成最严格的那一版。

**怎么改**：

```json
"csp": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
```

（`data:`/`blob:` 的图片是底图和掩膜；`'unsafe-inline'` 的 style 是 Svelte 的样式注入——先跑起来，再逐条收紧。）

**怎么验证**：`tauri build` 后启动，把开发者工具的 Network 全清、断网跑一遍导入/识别/导出；控制台里不应出现任何 CSP 违规。特别注意 Web Workers：`optimizer-worker.ts` 和 `solver` 的 worker 需要 `worker-src 'self' blob:` 才不被拦。

**成本**：半天（主要是试出 `worker-src` / `connect-src` 的正确组合）。

---

## 3. P1：同一个事实有两个主人

这一组是**架构层最实在的问题**：不是代码丑，而是有两个地方都能改同一个东西，于是迟早不一致。

### 06 · 掩膜换了原点，缓存以为什么都没变 ✅ 已实现

**位置**：`src/lib/state/floor-state.svelte.ts:427-431`、`src/lib/canvas/renderers/heatmap.ts:977`、`src/lib/state/optimizer-coverage.svelte.ts:96`

**结论（实现后）**：根因是 `translateFloor` 就地改 origin，违反 `mask-registry.ts` 自己写下的规则。现在三个掩膜通过 `shiftMask` 换成新对象；另外两处"按 dataUrl / 按楼层 id 建键"的缓存也把 origin 纳进了键（`heatmapMaskTag`、覆盖率的 `cachedMaskOriginX/Y`）。`translate-floor.test.ts` 钉住了"移动后是新对象、旧对象不动"。

**用户看到的现象**：用"对齐楼层"把一层整体挪到另一层上，覆盖率/热力图开始和墙对不上；把楼层切走再切回来（强制重算）又好了。

**机制**：三层叠加。

第一层，`translateFloor` 就地改掩膜的原点：

```ts
// floor-state.svelte.ts:427-431
for (const mask of [floor.wallMask, floor.materialMask, floor.roomTypeMask]) {
  if (!mask) continue;
  mask.originX += dx;
  mask.originY += dy;
}
```

对象还是**同一个对象**（`===` 成立），`dataUrl` 一个字都没变。

第二层，缓存是这么判断"能不能复用"的：

- 热力图的衰减场缓存，键是 `位置 + 半径 + fast + 楼层标签`：

```ts
// propagation.ts:402
const key = `${fast ? 'f' : 'a'}:${qx}:${qy}:${(radius / 4) | 0}:${maxDistFactor}:${cacheTag}`;
```

  `cacheTag` 在 `CanvasView.svelte:977` 是 `floor:${floorId}` —— **只有楼层 id，没有掩膜身份，也没有原点**。这个缓存只在 `wallGeneration` 变化时清空（`propagation.ts:392-394`），而 `wallGeneration` 由 `markWallsDirty()` 推。

- 覆盖率缓存，键更直接：`if (mask.dataUrl === cachedMaskUrl && ...) return true;`（`optimizer-coverage:96`）—— dataUrl 没变 → 直接认定"不用重算"，连 origin 都不重新拷。

第三层，对齐这条路径**恰好不会**触发 `markWallsDirty`：`commitAlign` 之后会调 `syncVectorWallsToMask()`，而它对"墙是位图、没有线段"的楼层在 `CanvasView.svelte:218` 直接 `return`。

所以：原点改了、对象没换、缓存键没包含原点、失效信号没发 → 整个会话继续用**旧坐标系**算衰减和覆盖率。

**为什么注释里说没事**：`mask-registry.ts:11-17` 把"没有任何路径会就地改掩膜"写成了事实。对齐就是那条路径，只是它写在别的文件里。

**怎么改**（两处都要，第一处是根因）：

```ts
// 1) 不要就地改，发新对象
floor.wallMask = { ...mask, originX: mask.originX + dx, originY: mask.originY + dy };

// 2) 一个统一的缓存键，所有按身份缓存的地方都用它
//    mask-registry.ts
export function maskCacheKey(mask: Mask | null): string {
  if (!mask) return '0';
  return `${maskIdentity(mask)}@${mask.originX ?? 0},${mask.originY ?? 0}`;
}
```

把 `heatmapLayer.maskTag`、`optimizer-coverage` 的 `cachedMaskUrl`、`propagation` 的 `cacheTag` 都换成 `maskCacheKey`。

**怎么验证**：单测——同一张掩膜，`originX` 从 0 改到 10，`maskCacheKey` 必须变；e2e——画一面墙、记覆盖率、对齐楼层、断言覆盖率重算（或断言 `cachedMaskUrl` 变了）。

**成本**：约 20 行核心改动 + 3 处调用点。

---

### 07 · "建筑内部/房间编号"被算了两遍 ✅ 已实现（编号稳定性除外）

**位置**：`src/lib/canvas/mask-pipeline.svelte.ts:203-210`、`src/lib/state/optimizer-support.ts:83-91`、`src/lib/canvas/region-labels.ts:18-23`

**结论（实现后）**：七个调用点现在都走 `canvas/rooms.ts` 的 `buildRoomDomain`，参数只在这里定义。每个调用方保留唯一一个真正该由它决定的选项：**是否裁掉贴墙的一圈**（放置域裁，画面和密度图不裁）。其余（工作分辨率、闭运算半径、最小房间半径）全部共享——**画布的房间编号现在和密度图一致**，这就是用户设的密度能落到正确房间的原因。

关键取舍：**所有调用点都保持原来的参数**，所以优化器、覆盖率、点击守卫、worker 算出来的数字一个都没变；变的是画布自己的分区（那本来就是错的那一半）。

**仍未做**：编号**不是稳定的**——画一道墙就可能重排房间号，这也是为什么覆盖值属于"房间"而不是"位置"。要真稳定需要给房间一个几何 key，并改项目文件格式。

**用户看到的现象**：在某个房间里把"人员密度"调高，优化器却不往那个房间多放 AP；有时它甚至像去照顾了隔壁房间。

**机制**：同一个概念被两套参数算了两次，而结果的**编号**被当成两边通用的语言。

编辑时（画布上那个 `regionId`，用户设的覆盖值按它写下）：

```ts
// mask-pipeline.svelte.ts:203-210
const interiorResult = computeBuildingInterior(decoded.data, w, h, { maxDim: 400 });
this.interior = interiorResult.interior;
this.roomLabels = labelRooms(this.interior, w, h);   // 默认：dilateRatio 0.04, minDilateR 10
```

优化时（按房间加权的密度图）：

```ts
// optimizer-support.ts:83-91
const { interior } = computeBuildingInterior(decoded.data, w, h, {
  maxDim: 400, dilateRatio: 0.04, minDilateR: 4,
  minRegionRadius: minRoomRadiusWu()      // ← 多了一个"最小房间半径"
});
densityRoomLabels = labelRooms(interior, w, h).labels;
```

参数不同 → 内部区域不同 → 房间切分不同 → **编号对不上**。而编号是自增序号：

```ts
// region-labels.ts:18-23
const label = nextLabel++;
```

只要闭合半径差一点，第三个房间之后所有编号全部平移。于是 `roomDensityOverrides["3"]` 在优化器看来是另一个房间。类型系统看不出来（两边都是 `number`），测试也看不出来（没人同时测两边）。

同时这是全 app 最贵的派生量：7 个调用点、至少 4 套参数、单次约 900 ms（`ap-interior.ts:107-111` 自己写了这个数字）。

**怎么改**：把"内部 + 房间 + 编号"变成一个**有主人的派生对象**，缓存键跟 `getFloorMask` 走：

```ts
// 新文件 state/floor-rooms.ts
export interface FloorRooms {
  interior: Uint8Array;
  labels: Int32Array;
  /** 稳定的房间标识：不用序号，用"这个房间的质心 + 面积"的哈希 */
  ids: string[];
}

// 两套参数是**两套用途**，所以显式命名，而不是靠调用方随手传
export const SEALED = { maxDim: 400 } as const;                                  // 画布显示/编辑
export const COVERAGE = { maxDim: 400, minDilateR: 4, minRegionRadius: ... };    // 覆盖率/密度
```

然后覆盖值不要用序号做 key，用 `ids[]` 里的稳定哈希。

**怎么做才不破坏现有项目**：`roomDensityOverrides` 是持久化的（在项目文档里）。改 key 的话要在 `project-document.ts` 的 `migrate` 里做一次版本升级：用新的 `ids` 按几何位置（质心最近）匹配旧序号。

**怎么验证**：单测——同一张掩膜用两套 preset 各算一次，断言"用户点中的那个房间"在两边是同一块像素区域（按质心/面积，不是按序号）；e2e——给一个房间高密度，跑优化，断言 AP 分布确实偏向它。

**成本**：约 60 行新模块 + 删掉 3 处参数字面量；迁移和测试 1 天。

---

### 08 · 覆盖率被当项目数据存，且无人失效 ✅ 已实现

**位置**：`src/lib/state/project-document.ts:150`、`optimizer-coverage.svelte.ts:597`、`optimizer.svelte.ts:743`

**结论（实现后）**：每条覆盖率都带一个 `basis`——它描述的那份方案（墙 + 掩膜身份 + 掩膜位置 + 材料 + 标定 + 该层每个 AP 的位置/功率/信道）。每次重算前先 `dropStaleCoverage()`，basis 对不上的条目直接删除。同时 `toDocument` 不再写覆盖率、`applyDocument` 不再应用它——从文件恢复的数字没有 basis，第一次重算就被丢掉（旧文件里的这个字段 `migrate` 仍然接受，所以老项目照常能打开）。

**代价**：打开项目后，在第一次重算跑完之前面板显示"没有数字"而不是上次的数字。少一个数字是看得见的，多一个错的看不见。

**用户看到的现象**：改了墙、删了 AP，覆盖率数字还是老的；导出的 PDF 报告里印的是上一版方案的数字；把项目存盘再打开，那个错误数字跟着回来了。

**机制**：
`floorCoverage`（每层覆盖率）是**测量结果**，不是用户输入，但它被写进了项目文档（`project-document.ts:150`）。

它有两个写入者，精度不同（实时那道最多 140 个采样点，运行那道最多 400 个）。**这本身不算缺陷**——每个写入者都把"数字"和"它来自多少样本"配对写入，所以加权是自洽的。真正的缺陷是下面这条：

没有任何东西让它失效：改墙不重算、删 AP 不重算、撤销不回滚（`history.svelte.ts:55-59` 只快照 floors + aps）。于是数字、图表、PDF 报告都指向一个已经不存在的方案，而这个数字还被存进了项目文件。

**怎么改**（推荐"派生，不存"）：

1. 从 `DocumentFloor` 里删掉 `coverage` 字段，`migrate` 遇到旧文件直接忽略它（丢掉一个测量值不丢数据）；
2. 覆盖率只保留一份定义：一个 `coverageSummary`，订阅 `apState.aps` + `floorState.floors` + 掩膜版本，任何输入变了就作废重算；
3. 实时消耗和优化结果用同一个采样器，只是采样数不同 —— 数字里要带 `sampleCount`，UI 显示"基于 N 个样本"。

**怎么验证**：单测——改一面墙，断言 `coverageSummary` 的版本号变了；删 AP 同理；`project-document.test.ts` 加一行"旧文档里的 coverage 被丢弃且不报错"。

**成本**：约 50 行 + 文档版本升级。

---

### 09 · 撤销没有"文档边界" ✅ 已实现

**位置**：`src/lib/export/json.ts:88`、`src/lib/state/history.svelte.ts`

**结论（实现后）**：`clearHistory()` 移进 `applyDocument`（所有加载都走这扇门），`persistence` 里重复的那次调用删掉了；新建项目对话框不经过 `applyDocument`（它是逐字段重置状态），所以它自己那次调用保留。`project-document.test.ts` 钉住"应用一份新文档后撤销/重做都是空的"。

**用户看到的现象**：File → Import 打开别人的项目，手滑按了一下 Ctrl+Z —— 项目名、频段、单位还是别人的，平面图和 AP 变回了**你上一个项目**的。

**机制**：
撤销快照只含三样东西：

```ts
// history.svelte.ts
{ aps, floors, currentFloorId }
```

项目级的东西（名字、频段、监管域、自定义材料、单位制）不在里面。

而"打开一个项目"这条路径，只有两处清空了历史：

- `persistence.svelte.ts:220-221`（恢复上次会话）→ 调了 `clearHistory()` ✅
- `NewProjectDialog.svelte:75`（新建）→ 调了 ✅
- `export/json.ts:88`（**导入文件**）→ `applyDocument(doc, ...)` 之后只 `clearSelection()` ❌

所以导入之后，历史栈里躺着的仍然是导入前的项目。第一次撤销把 `floors` + `aps` 换回旧项目，`projectMeta` 却是新导入的 —— 一个不可能存在的组合。而自动存盘 5 秒后把这个混合物写进存储。

**怎么改**：把"换文档"收进一个门里，别让每个调用点自己记得：

```ts
// project-document.ts —— 唯一的 document → state 入口
export function applyDocument(doc: Document, deps: ApplyDeps): void {
  clearHistory();          // ← 就加在这里
  ...实际应用...
}
```

然后把 `persistence` / `NewProjectDialog` / `export/json` 里手写的 `clearHistory()` 删掉（重复调用无害，但会误导下一个人以为它是调用方的责任）。

**怎么验证**：单测——`applyDocument` 之后 `canUndo()` 必须是 `false`；e2e——导入 → Ctrl+Z → 断言项目名和内容都属于新导入的文件（或什么都没变）。

**成本**：3 行 + 一个测试。

---

### 10 · 墙衰减：不是死参数，是名字和注释撒了谎 —— **结论：保留，已就地澄清**

**位置**：`src/lib/rf/propagation.ts:94-99`、`src/lib/canvas/materials.ts:240-248`

**结论（复核后）**：我原来写"死参数"是**错的**，和 08 一样。它**有活的用途**：一个墙像素指向的材料 id 在表里不存在时的兜底价。典型场景——用户加了个自定义材料、用刷子把墙刷上、**然后把那个材料删了**：掩膜里那些像素还留着旧 id，没有兜底它们就按 0 dB 算，等于这些墙不存在。材料表只填满 `0..maxId` 的洞，`maxId` 之外的 id 正好落到这个兜底上。

所以**不能注释掉**：`materialDb[matId] ?? defaultDb` 会变成 `?? undefined`，`total += undefined` → NaN → 整层覆盖率和热力图变 NaN。

**真正死掉的是"能改它的 UI"**（现在只有新建项目对话框初始化它），以及**注释的措辞**——六处调用点都写着"honours the project's explicit wall attenuation"，读起来像"这层所有墙的衰减"，而它其实只影响"材料查不到"的情况。名字 `wallAttenuation` 也是这么误导人的。

**已做**：给 `Floor.wallAttenuation` 补了准确的文档注释（说明它是"未知材料的兜底价"，以及为什么不能直接删），并在真正扣费的那一行写清楚它是什么。

**如果以后真要清掉它**，需要两件事，而不是一次删除：①决定"墙的材料被删了应该算多少"；②一次文档迁移（`migrate` 把老文件里的值搬到一个新的、语义正确的字段，或者固定成一个常量并接受老项目的物理数字会变——v2 的样例文件里这个值是 9，不是默认的 5）。

**用户看到的现象**：没有 UI 能改它，所以其实没人注意 —— 但项目文件里存着这个字段，撤销测试里钉着它，每个 worker payload 里传着它。

**机制**：
墙体损耗的计算是"每个像素查材料表"：

```ts
// propagation.ts:94-99
const matId = materialMap ? (materialMap[idx] ?? defaultMaterialId) : defaultMaterialId;
if (matId !== runMaterial) {
  total += materialDb[matId] ?? defaultDb;   // ← 只有 matId 没有材料行时才用 defaultDb
  runMaterial = matId;
}
```

而材料表是被**填满**的：

```ts
// materials.ts:240-248
for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = fallback;
```

`out[material.id]` 对表里每种材料都赋了值，所以只要 `matId` 落在已定义范围内，`?? defaultDb` 就**不会执行**。`defaultDb` 在 6 个地方由 `floor.wallAttenuation` 算出来传进去（`optimizer-worker.ts:432-435`、`optimizer-coverage:475`、`heatmap.ts:953-954` 等等），每次还都配一句"honours the project's explicit wall attenuation"的注释。

真正会走到 fallback 的只有一种情况：掩膜里某个像素指向一个**已经被删除的自定义材料 id**（表里没有那一行，长度不够）。也就是说，这个参数的语义已经从"所有墙的衰减"悄悄变成了"已删除材料的兜底值"。

**怎么改**：二选一，别停在中间。

- **删掉**：从 `WallRun` 去掉 `fallbackDb`、从 `Floor`/`DocumentFloor` 去掉 `wallAttenuation`、删掉 6 处计算和注释。这最诚实。
- **保留并让它有用**：把 UI 放回来（让用户能改），并明确它的语义是"没刷材料的墙按多少算" —— 那就得让 `matId === defaultMaterialId` 时走它，而不是走表里 drywall 那一行。

**怎么验证**：单测——`materialDb[id]` 有值时，`fallbackDb` 传 999 和传 1 结果必须一样（现在就是一样，把这个事实钉住）；或者反过来，改成生效之后断言不一样。

**成本**：删是 60–80 行净减少；改成生效约半天 + 一个 UI 控件。

---

## 4. P2：取消、协议、重复实现

### 11 · Cancel 是装饰性的 ✅ 已实现

**位置**：`src/lib/state/optimizer.svelte.ts:954`、`:791-792`

**结论（实现后）**：一次运行现在有自己的 `AbortSignal`，循环在 restart 前、楼层前、额外 ε pass 前、以及 `optimizeFloor` 干重活（解掩膜、装 payload）之前都检查它；`cancelOptimizer` 同时 abort 信号和两个 worker（运行的那个 + 图的那个）。被取消的运行也不再更新 `lastRunAt`——"有了一次新鲜测量"这句话对半途而废的运行不成立。

**用户看到的现象**：点"优化所有楼层"，跑了 30 秒还没完，点 Cancel —— 按钮灰了，但风扇还在转，十几秒后才停。

**机制**：

```ts
// optimizer.svelte.ts:954
export function cancelOptimizer(): void {
  bridge.cancel();          // ← 整个函数就这一句
}
```

`bridge.cancel()` 只对**当前那一个请求**发了取消信号。而外面套着三层循环（楼层 × restart × ≤4 个 pass），每一层拿到"失败"之后的行为是**继续**：

```ts
// optimizer.svelte.ts:791-792
const outcome = await optimizeFloor(floorId, { ...extra, seed: i + 1, apply: false });
if (!outcome.ok) continue;        // ← 取消被当成"这一轮跳过"
```

取消异常在 `:620-621` 被翻译成 `ok:false`，于是循环接着跑下一个 restart / 下一层。`isRunning` 要等整个 `withOptimizerRun` 的 `finally`（:723-726）才归 false —— 也就是全部跑完才归 false。另外 `graphBridge`（:47，冲突图那个桥）**从来没被取消过**。

**怎么改**：一次运行一个 `AbortSignal`，每个循环边界检查：

```ts
const run = new AbortController();

async function optimizeFloor(floorId: string, opts: Opts, signal: AbortSignal) {
  if (signal.aborted) throw new RunAborted();
  ...
}

// 循环里
for (let i = 0; i < n; i++) {
  if (run.signal.aborted) break;
  ...
}

export function cancelOptimizer() {
  currentRun?.abort();
  bridge.cancel();
  graphBridge.cancel();      // ← 别忘这个
}
```

`RunAborted` 要跟"这一轮没找到更好的解"区分开：前者往上抛到 `withOptimizerRun` 的 catch 里，后者才 `continue`。现在这两种情况被同一条 `if (!outcome.ok)` 混在一起了，这也是为什么取消看起来像"跳过"。

**怎么验证**：单测——`optimizeFloor` 在 `aborted` 的 signal 下必须抛 `RunAborted`；集成——mock bridge 让第一次调用 reject('Cancelled')，断言剩下的 restart 一次都没被调用。

**成本**：约 50 行，跨 4 个函数。

---

### 12 · worker 协议分不清两次请求 ✅ 已实现

**位置**：`src/lib/workers/optimizer-bridge.ts:98-121`、`optimizer-worker.ts:281-309`

**结论（实现后）**：每条请求带 `runId`、每条回复原样带回，桥只接受匹配当前请求的回复；worker 在运行中收到第二条 `optimize` 直接回 `busy`（桥译成"另一个优化还在跑"）；`cancel` 按 runId 生效，且在无请求在飞时什么都不发（否则会停掉用户刚点的下一次）；`cancel` 立即 reject，不等 worker 确认。顺手把 seed/PRNG 从模块级挪进"这一趟运行"——被取消的运行还没停时，它的抽样不能来自接替它的那一趟，否则报告的 seed 复现不了结果。

**仍未做**：`OptimizeMessage` / `OptimizeResult` 两边各声明一次，桥那边还是无类型字面量，编译器不互校——这需要单独一次改动。

**用户看到的现象**：偶尔一次运行的结果"不像这次该有的"（分数和屏幕上完全不匹配），或者卡住一直转圈。

**机制**：
桥这一侧只有**一对** pending 回调：

```ts
private pendingResolve: ((value: OptimizeResult) => void) | null = null;
private pendingReject: ((reason: unknown) => void) | null = null;

this.worker.onmessage = (event) => {
  const { data } = event;
  if (data.type === 'result' && this.pendingResolve) {
    this.pendingResolve(data as OptimizeResult);   // ← 谁回的？不知道，反正就是它
    this.cleanup();
  }
  ...
};
```

发新请求时，先把旧的 reject 掉（`new Error('Superseded')`），再把新的存进去。

worker 那一侧，运行期状态是**模块级变量**：

```ts
// optimizer-worker.ts:281-309
let cancelled = false;
let random: () => number = Math.random;
// 每条新消息都重写这三个：cancelled / runSeed / random
```

而 `runOptimization` 中途会 `await yieldToEventLoop()`（好几处，:1678/:1877/…），所以第二条 `optimize` 消息**真的能在第一条跑一半时被派发进去**。两个搜索从此共享 `random`、`runSeed`、`cancelled`，也共享两个进程级全局（`setPathLossScenario`、`registerCustomMaterials`）。第一条的结果回来时，`pendingResolve` 指向的是**第二条**的 promise，而结果里的 `seed` 是第二条消息写进去的。

今天没出事，只是因为 UI 层有一道 `if (optimizerState.isRunning) return`（`optimizer.svelte.ts:711`）—— **这是 UI 约束，不是协议属性**。任何一个新入口（比如导入项目后自动重跑）绕开它就炸。而且 `Superseded` 不在调用方对 `Cancelled` 的过滤里，会直接落进 `optimizerState.error` 显示给用户。没有超时，所以一次沉默就让 `isRunning` 卡到会话结束。

**怎么改**：

```ts
// 1) 每条消息带 runId，每个回复原样带回
type OptimizeMessage = { runId: string; ... };
type OptimizeReply   = { runId: string; type: 'progress' | 'result' | 'cancelled'; ... };

// 2) worker 侧：忙就拒绝，不要静默接管
let current: { runId: string; cancelled: boolean } | null = null;
if (current && !current.cancelled) {
  post({ runId: msg.runId, type: 'result', ok: false, error: 'busy' });
  return;
}

// 3) 桥侧：只 resolve 匹配的 runId；加超时
if (data.runId !== this.pending?.runId) return;   // 迟到的旧结果直接丢
```

顺便把 `OptimizeResult` 改成判别联合 `{ ok: true, ... } | { ok: false, error }`，并且**把消息体本身标成 `OptimizeMessage` 类型**——现在 `optimizer-bridge.ts` 里 `const msg = { ... }` 是个无类型字面量，worker 和桥各自声明了一遍字段，编译器从来没核对过它俩（`data as OptimizeResult` 这个 cast 就是那个缺口）。

**怎么验证**：单测（worker 侧纯函数化之后）——发第二条 `optimize`，断言回复 `busy` 且第一条不受影响；桥侧——resolve 一个 `runId` 不匹配的 result，断言 promise 仍 pending。

**成本**：约 60 行。

---

### 13 · "三套评估器一套墙损耗"只在慢路径成立 ✅ 已实现（几何原本就是对的，缺的是唯一入口）

**结论（实现后）**：worker 的快路径（Lloyd/PSO 真正打分用的那条）原本自己调用 `rayMarchWallAtten` 两次，并且**自己**做两件容易做错的事：减掩膜 origin、从材料表里挑默认材料（没有材料图时还要用本层自己的数值）。现在两半都走 `wallRunLoss` + 每层一个 `WallRun`，origin 和默认材料**只在一处**声明，和覆盖率、热力图、solver 完全一致。

几何是对的这件事要说清楚：它本来就是"从交点分别 march 两段"，而不是"整条减前缀"（注释里写明了原因）。所以这次改动是**纯管道**，不是修数值。

**数字验证**（不是"应该不变"，是量过）：`pnpm test:measure` 十四个场景，改前改后**逐位相同** —— `pair` / `pair-soft` / `free` / `free-soft` / `free6` / `limited` / `limited6` / `limited-soft` / `limited6-soft` / `trade` / `trade-weighted` 的分数、覆盖率、干扰全部一致。基线记在 `docs/MEASUREMENTS.md`（带 commit），因为 Playwright 每次运行都会清空 `test-results/`。

**仍未做**：stride 不同是**有意的**（热力图 2、solver 3、评估器 1），量化差异由 `rf/wall-charge-agreement.test.ts` 兜住（不许漏墙）。

**状态**：测量已经接上（`pnpm test:measure`，见 `docs/ARCHITECTURE.md`），但它**测不到这一条**——`tests/measure` 的全部场景都是"开阔矩形、没有内墙"，而这条讲的是穿墙怎么计费。所以这一条的验收不能靠现有测量，得先补一个共享 fixture：

1. ✅ 已有 `rf/wall-charge-agreement.test.ts`：一张有墙的小图（两种材料）、跨 0/1/2 面墙的射线、一条跨层劈分路径；
2. ✅ 钉住了：材料表每次穿越只计一次、`wallRunLoss` 与 `rayMarchWallAtten` 逐值相同、掩膜平移后结果不变（origin 的坑）、stride 2/3 只许量化误差不许漏墙、跨层劈分等于两半各按本层掩膜计；
3. **更正**：我原以为这个测试今天会红，实际**它是绿的** —— 因为 `wallRunLoss` 本来就直接调用 `rayMarchWallAtten`，共享层已经是同一个函数。真正的分歧在 worker 的**快路径自己减前缀**（两次 marching 相减，在步进边界附近可能差出一整面墙），而那段代码在 worker 里、node 环境测不到。所以这个 fixture 的定位是**重构期间的护栏**，不是"当前就红"的验收。

改法仍是文档里那套：`link-budget.ts` 提供 `prepareWallRun` + `wallRunSplitAt`，四处共用，删掉 `buildFixedPaths` 里内联的 march。会改动优化器的打分，所以要在**有墙**的场景下对比改前/改后的分数，而不是看现在这 13 个无墙场景。

**已确认的测量现状**（免得下次再查）：`pnpm test:measure`（需要 `MEASURE_INTERFERENCE=1`）现在是 **16 通过**。原先 3 条红（`free` / `free-soft` / `free6`）已查明并修正：它们要求"保留下来的分配零冲突"，而这三个场景是 **4 / 6 个 AP 挤在 2.4 GHz 的 3 个不重叠信道（1、6、11）上**，每对 AP 的覆盖圈都相交 —— 冲突**不可避免**，零冲突在数学上做不到。改成断言"把手上每个信道都用完之前不重复"（实测分配 6/11/11/1，3 个不同信道配 4 个 AP）。在改动前的干净 HEAD 上，旧断言同样是 0.2925 失败。

**顺带一个真实的不一致（已修，`44b7b62`）**：应用自己报的干扰是 0%，因为 **worker 打色时用的是全部 11 个候选信道**（`planningCandidates`，带部分重叠计费），而**求解器只有 3 个不重叠信道**（`planningChannels`）。所以面板的 0% 描述的是 worker 内部那份分配，用户拿到的是求解器那份 —— 两边的候选集不同。已采用"让读数永远描述最终分配"这一条：`optimizer-coverage` 的那趟采样本来就逐源算了余量，现在把它们留下来，按目标函数同样的裁剪（够不到的系统不算"能听到的次强"）跑 `violatesAt`，用的是 AP 身上真实的信道；并且**信道分配变化时也触发一次这趟采样**（`applyAssignments`）。

注意：这个数字**不在面板上显示**（`CoveragePanel` 有注释说明这是刻意的显示决定），它出现在 **PDF 报告**和**摆放建议**里 —— 所以受影响的是报告，不是屏幕。

另一条路（让 worker 用同一个 3 信道调色板）没有走：那会改变优化器所有历史分数，属于另一个决定。


**位置**：`docs/ARCHITECTURE.md:130-142`、`workers/optimizer-worker.ts:421-475` 与 `:824-855`、`canvas/renderers/heatmap.ts`、`state/solver.svelte.ts`

**先说明**：这条**不是让你把三个评估器合并**。它们的分歧（极坐标场 vs 步进、stride 1/2/3、采样策略）是有意的，合并等于拿性能换整洁。

**问题在"怎么算穿过一面墙"这件事，其实有四份。**

文档说三套评估器共享 `rf/link-budget.ts`。实际上：

1. **覆盖率那道**（`optimizer-coverage.svelte.ts`）—— 用 `splitWallRunLoss` ✅
2. **worker 的精确路径**（`fixedLossFor`，`optimizer-worker.ts:835`）—— 用 `splitWallRunLoss` ✅
3. **worker 的快路径**（`buildFixedPaths`，`optimizer-worker.ts:421-475`）—— 自己 `rayMarchWallAtten` 再自己减前缀，减的时候还有自己的 origin 约定（`seg.source.from.x - src.originX`），旁边 `:824-825` 的注释却写着"split 与覆盖率、热力图共用" —— 那句话对 2 成立，对 3 不成立。而 Lloyd/PSO 打分走的是 3。
4. **热力图**（`heatmap.ts`）—— 只 import 了 `wallRunLoss`（没有 `split`），前缀是自己从极性场里减出来的：`level += lookupAtten(field, seg.target.from.x, seg.target.from.y)`。
5. **solver**（`solver.svelte.ts`）—— 第四份手写（stride 3，跨层干脆是纯 slab dB，没有墙体劈分）。

结果是：三种 stride、三种原点约定、两套劈分算法，共同喂一次搜索和两个读数。文档那句"分歧在评估器，不在墙怎么算"因此**无法被证伪**——因为"墙怎么算"本来就有四份。

**为什么这很危险**：物理模型的任何一次修正，都得记得改 4 个地方；漏一处，热力图和优化器的数字就对不上，而现象是"看起来都挺合理"，没有人会去查。

**怎么改**（收敛"怎么算"，保留"在哪采样"）：

```ts
// link-budget.ts
export function prepareWallRun(mask, materialMap, band, origin): WallRun;
export function wallRunSplitAt(run: WallRun, from: Point, to: Point): { total: number; at: (p: Point) => number };
```

- 热力图从 `at()` 取前缀（不再自己减）
- worker 的 `buildFixedPaths` 删掉内联 march，改用同一个 `at()`
- solver 换成同一套（stride 3 作为参数保留）
- `link-budget.test.ts` 加一个**跨消费者一致性测试**：同一张掩膜、同一段墙、四个消费者必须给出同一个损耗（允许 stride 造成的量化误差，设一个 ε）

**怎么验证**：那个一致性测试就是验收标准。它现在会失败，改完必须绿。

**成本**：120–150 行移动/删除，2–3 天（因为会改到数字，需要跑 `tests/measure/` 里那套测量基线对比）。

---

### 14 · 每次 restart 重发全部几何 ✅ 已实现

**位置**：`src/lib/workers/optimizer-bridge.ts:325-372`

**现象**：一次"优化所有楼层 + 3 restart"，同样的墙掩膜被拷了十几遍。

**机制**：每次 `run()` 都把输入全量 copy 一遍再 transfer：

```ts
const maskCopy = new Uint8Array(wallMask);
const densityCopy = options?.densityMap ? new Float32Array(options.densityMap) : null;
const materialCopy = ...; const roomTypeCopy = ...;
// 加上每个跨层源的掩膜、每个 slab 的 roomTypes
```

拷贝是必须的（调用方缓存着解码后的掩膜，transfer 会把 buffer detach 掉），但**每次 restart 都重来一遍**就没必要了：restart 之间几何完全一样，只有 seed 变。

3000² 的掩膜是 9 MB，材料图再加 9 MB，密度图 float32 再加 36 MB —— 乘上 "楼层数 × restart 数"。

**怎么改**：加一个"会话"概念，几何只发一次：

```ts
// 第一次 run
post({ type: 'load', runId, geometry: {...} }, transferables);
// 之后每个 restart / 每层
post({ type: 'optimize', runId, seed, n });   // 只带参数
```

worker 侧用 `runId → geometry` 的 Map 存，run 结束（或新 runId）时清掉。这样 restart 从"重发 50 MB"变成"发 200 字节"。

**怎么验证**：在 bridge 里给 transfer 的字节数打个 `debug()` 计数（`log.ts` 已经有这套），跑 3 restart，断言第二次之后 transfer 是 0。

**成本**：约 120 行（worker 侧要接受"没有几何"的消息）。

---

## 5. P3：可以机械化的重复

这一组不是 bug，是"同一个模式手工抄了很多遍，所以每次加功能都要记得抄对"。

### 15 · 7 个互斥模式写成 7 个 boolean ✅ 已实现

**位置**：`src/lib/state/app.svelte.ts`

**结论（实现后）**：`appState.tool` 一个字段（`'none' | 'wall' | 'note' | 'align' | 'calibrate' | 'planning' | 'surface' | 'place-ap'`），`setTool` 是唯一改它的地方。七个 boolean 变成**在这个字段上的访问器**——所以现存的 62 处读、34 处调用一行都不用改，而且谁也绕不过互斥：`appState.noteMode = true` 现在**就是** `setTool('note')`。副作用（对齐模式借走/归还楼下幽灵、切换时丢掉草稿）全部收进 `setTool`。`appState-modes.test.ts` 七条用例钉住"一次只有一个工具"。

**没有合并的部分**：`wallTool`（line/rect/circle/eraser）保持独立字段——它是画墙工具画什么形状的**偏好**，跨"开关墙工具"存活，不是一个模式。

**现象**：偶尔两个工具同时"激活"（比如规划区域画到一半，又点了画墙工具），点一下画布做了两件事。

**机制**：同一个状态（"现在是什么工具"）用 7 个独立的布尔量表达：

```ts
wallVectorMode  (68)    noteMode (98)        floorAlignMode (113)
calibrateMode   (115)   planningDrawMode (123) surfaceMode (133)  apPlaceMode (158)
```

"互斥"是靠 5 个 setter 手写的"进入时把别人关掉"来维持的，而且每个 setter 都在重复前面所有人的清单：

```ts
setCalibrateMode:      setApPlaceMode(false); setFloorAlignMode(false);
setPlanningDrawMode:   setApPlaceMode(false); setFloorAlignMode(false); setCalibrateMode(false);
setSurfaceMode:        ...再补一个 setPlanningDrawMode(false);
```

这是 O(n²) 的手写清场：加第 8 个模式，要改 7 个地方。

而 `wallVectorMode` 和 `noteMode` **根本不在这个体系里** —— 它们被 3 个组件直接赋值（`FloorplanControls.svelte:641,827,1256`、`FloorplanNotes.svelte:82,98`、`CanvasView.svelte:1813,2007`），谁也不清谁。所以"画墙工具 + 规划区域绘制"是可以同时为真的。

**怎么改**：一个字段、一个入口。

```ts
export type Tool =
  | { kind: 'none' }
  | { kind: 'wall'; shape: 'line' | 'rect' | 'circle' | 'eraser' }
  | { kind: 'note' }
  | { kind: 'align' }
  | { kind: 'calibrate' }
  | { kind: 'planning' }
  | { kind: 'surface' }
  | { kind: 'place-ap' };

export const appState = $state({ tool: { kind: 'none' } as Tool, ... });

export function setTool(tool: Tool): void {
  appState.tool = tool;                 // 互斥是类型自带的，不需要清场代码
  // 只有真正需要副作用的这里写一次：对齐模式拥有 ghost、校准模式清点、规划模式清草稿
}
```

然后所有 `if (appState.xMode)` 变成 `if (appState.tool.kind === 'x')`。7 个布尔 + 5 个 setter 变成 1 个联合类型 + 1 个函数。

**怎么验证**：单测——挨个设置每个 tool，断言同时只有一个 `kind`；删掉所有 "把别人关掉" 的语句之后 e2e 仍然绿。

**成本**：半天（改动点多但机械）。

---

### 16 · CanvasView 手写同步 15 个图层 —— 结构性危害已消除，effect 数量未动

**结论（部分实现）**：这条的两个**真实危害**都处理掉了，剩下的"40 个 effect"是数量问题，不是正确性问题。

1. **绘制顺序**从 20 次 `addLayer` 变成 `engine.setLayers([...])` —— 顺序即数据，在一个地方读完。
2. **"只有单层视图才显示"** 从 14 份手写比较变成一个有名字的 `singleFloorView`。
3. **图层不再是"挂载后才存在"**：16 个图层在组件初始化时就建好（`const`），25 个 `if (!layer) return` 守卫全部删除。那个守卫不是防御性代码，它问的是一个只有 Svelte 的 effect 刷新顺序才能回答的问题 —— 而守卫失败不会抛错，它只会让那个 effect 永久失效。
4. **"楼层切换的 reset 必须先跑"** 这条不变量消失了：`MaskPipeline` 自己记住缓存属于哪一层，在 `syncWallMask` 开头自己清。原来它靠"这个 effect 声明在解码 effect 上面"维持 —— 在一个 2247 行的文件里把一个块往上挪一次就会静默画错楼层。

**仍未做**：把几十个"读三个字段 → 赋给图层 → markDirty"的 effect 收进一个 `LayerSpec` 注册表。这是模板化的重复，改了能少几百行，但每一条都得手工核对语义，而且 e2e 未必抓得住某个字段漏同步 —— 建议单独一轮，专门做这个。

**位置**：`src/lib/components/canvas/CanvasView.svelte`（2247 行，全仓变更最频繁的文件：34/92 次提交）

**现象**：加一个新图层要改 2–3 处；偶尔某个图层的某个状态忘了同步，表现是"某个模式下画布不刷新"，而且要很久才发现。

**机制**：这个组件实际上是一张手工维护的"15 个图层 ← 20 个状态模块"的同步表：

| 数字 | 含义 |
| --- | --- |
| 15 | 图层变量（`apLayer`、`wallLayer`、`heatmapLayer`、`stackedFloorsLayer`…） |
| 75 | `xxxLayer.field =` 这样的赋值 |
| 45 | `markDirty()` 调用 |
| 40 | `$effect`，其中 32 个以 `markDirty()` 结尾 |
| 13 | 重复的可见性判断 `visible = floorView === 'single' && showX` |
| 20 | 顺序写死的 `engine.addLayer(...)`（绘制顺序 = 调用顺序） |

还有两条**没有写在任何地方的**不变量：

- 每个 effect 开头的 `if (!apLayer) return;` 读不到任何信号（图层是普通 `let`，只在 `onMount` 里赋值）。所以它只靠"`onMount` 在源码里排在这些 effect 前面"这一个事实成立。一旦顺序变了，那个 effect 会**永久失效**，而且不报错。
- 楼层切换的 effect（:1017-1031）必须排在解码 effect（:1054-1056）**之前**，否则 `maskPipeline.reset()` 会把刚解码好的掩膜清掉。

**怎么改**：把"声明"和"同步"分开。

```ts
interface LayerSpec {
  layer: Layer;
  /** 只在哪些视图里出现 */
  views: ('single' | 'tiled' | 'stacked' | 'floor3d')[];
  /** 用户开关（跟着 appState 走） */
  enabledBy?: () => boolean;
  /** 这个图层依赖哪些状态：给一个快照对象，框架负责 diff + markDirty */
  inputs: () => Record<string, unknown>;
}
```

`engine.setLayers(specs)` 一次处理顺序、可见性、`markDirty`。预计净减少约 250 行，并消灭"漏一个 effect"这一整类 bug。

**建议做法**：别一次重写。先抽"可见性判断"（13 处 → 1 处），再抽"图层顺序"（20 个 `addLayer` → 一个数组），最后再动 effect。每一步都能单独跑 e2e 验证。

**怎么验证**：每抽一步跑一遍 `pnpm test:e2e`（105 个用例，覆盖了各种视图切换）。抽完之后 `grep -c markDirty` 应该显著下降。

**成本**：2–3 天，分 3 步。

---

### 17 · 渲染循环存在三份 ✅ 已实现

**位置**：`canvas/engine.ts:104-110`、`export/png.ts:45-52`、`export/pdf.ts:610-616`

**现象**：导出时按图层 id 过滤（`layer.id === 'grid'`、`'selection-rect'`），魔法字符串散在三处；新加一个图层要记得把它加进导出的排除列表，否则导出图里会多出网格或选中框。

**怎么改**：一层接口上解决。

```ts
interface Layer {
  id: string;
  render(ctx: CanvasRenderingContext2D, camera: Camera): void;
  /** 这个图层要不要出现在导出物里 */
  exportable?: boolean;
}
```

`engine.renderInto(ctx, { skip: (l) => !l.exportable })`，PNG 和 PDF 都调它，删掉两份复制的 `compositeOffscreen`。

**成本**：约 40 行。

---

### 18 · `wall-detect.ts` 还兼着一个编解码器（OCR 那半已删除）✅ 已实现

**位置**：`src/lib/canvas/wall-detect.ts`

**状态**：原本这条是"一个文件塞三件事：`tesseract.js` 的顶层 import、PNG 编解码、400 行栅格 CV"。**OCR 那部分已经删除**——它从来没在应用里跑过（唯一的调用点一直传 `skipOcr: true`），而且模型要从 CDN 拉。现在 `tesseract.js` 这个依赖整个没了（`pnpm install` 少装 12 个包），构建产物里也不再有它。

**还剩什么**：`decodeMask` / `encodeMask` 这两个纯编解码函数仍然住在 `wall-detect.ts` 里，而 **7 个模块 import 这个文件只是为了它们**：`floor-mask.ts`（启动路径）、`mask-pipeline`、`optimizer-coverage`、`optimizer-support`、`CoveragePanel`、`FloorplanControls`、`CanvasView`。

**为什么还值得拆**：`wall-detect.ts` 现在是一个"位图读取器"（阈值、连通域、背景判定），而编解码是"PNG ↔ 像素数组"，两者没有关系。把编解码放回去，任何读掩膜的模块都不必为了一个 60 行的函数去 import 一个 600 行的 CV 文件——而且以后真要换编码格式（比如从 data URL 换成 `createImageBitmap`），改动面才是 1 个文件而不是 7 个调用点的心理负担。

**怎么改**：

```ts
// canvas/mask-codec.ts —— ~60 行，零依赖
export function decodeMask(dataUrl: string, w: number, h: number): Promise<DecodedWallMask>;
export function encodeMask(data: Uint8Array, w: number, h: number): string;
```

`wall-detect.ts` 只留检测；7 个调用点改 import。`DecodedWallMask` 类型跟着编解码走。

**另一个独立问题（还没做）**：`Toolbar.svelte` 静态 `import { exportPdf }`，于是 jsPDF 在入口 chunk 里，而它只在用户点导出时才用得上。改成 `const { exportPdf } = await import(...)` 即可。

**怎么验证**：`pnpm build` 之后看产物：`jspdf` 应该变成一个独立 chunk，入口 chunk 明显变小。

**成本**：拆编解码半天；jsPDF 动态化 1 小时。

---

### 19 · 领域数据表住在 `canvas/` 里

**位置**：`src/lib/canvas/materials.ts`、`src/lib/canvas/room-types.ts`

**现象**：`ARCHITECTURE.md` 说"`rf/` 是纯的，只许 import `canvas/room-types.js`"，但你去查会发现 `rf/raster-ray.ts`、`rf/reflection.ts`、`rf/wall-crossings.ts` 还 import 了 `canvas/materials.js`。

**为什么这是问题**：规则写得比现实窄 → 看代码时**没法区分"这是违规"和"这是一张数据表"**。而只要那两张表在 `canvas/` 里，`rf/` 就永远有一根线牵回渲染层，"rf 是纯的"这句话就只是宣言。

**规模**：`materials.ts` 被 **30 个模块** import（含 `rf/` 和 worker），`room-types.ts` 12 个。它们都是纯数据 + 纯函数，没有 DOM、没有 state。

**怎么改**：搬到承载"领域"的地方 —— `src/lib/domain/`（或 `packages/` 里新建一个 `materials`）：

```
src/lib/domain/materials.ts      ← 原 canvas/materials.ts
src/lib/domain/room-types.ts     ← 原 canvas/room-types.ts
src/lib/domain/materials.test.ts ← 补一个（现在没有）
```

然后 `ARCHITECTURE.md` 的规则改成："`rf/` 可以 import `domain/` 的纯数据表，不能 import `canvas/`、`state/`、`components/`。" 这条现在是**可以用 grep 机械检查**的。

**成本**：半天（纯移动 + 改 import 路径），顺手补一个测试；可以加进 CI 防止回退：

```bash
# 一个 grep 就能守住的规则
! grep -rE "from '.*(canvas|state|components)/" src/lib/rf/
```

---

## 6. 顺手能清掉的小债

| 位置 | 问题 | 成本 |
| --- | --- | --- |
| `state/floor-mask.ts:58-85` | ✅ 已删：`setLiveSolverMask` 全仓无人调用，`getFloorMask` 里那个分支会返回 `originX:0, originY:0` | 15 行删除 |
| `canvas/shortcuts.ts:191-203` | ✅ 已删：两条 `mod+z` 分支永远到不了（前面已经接住了，且这两条不存盘） | 10 行删除 |
| `components/canvas/CanvasView.svelte:638` | `restoreFromStorage()` 没 await，启动瞬间的编辑可能被加载覆盖 | 1 行 |
| `state/project-document.ts:313` | `migrate` 接受任何 `version >= 2`，却按当前版本重写；旧版打开新文件会静默截断数据 | 半天（加严格校验） |
| `state/i18n.svelte.ts` | 644 行单文件，92 次提交里改了 26 次（和 CanvasView 共同变更 14 次）；约 1/3 条目已无法从 `src/` 触达。`t("Don't show this again")` 用双引号，目录测试的正则看不见它 | 1 天（按面板拆文件 + 校验双向） |
| 侧栏 3 个面板 | 各带 350–380 行 CSS，类名几乎不重叠（4 个文件只有 2 个重名）。primitives 已经有了（`shared/` 9 个），缺的是 Row / Field / Section 这类**组合件** | 1–2 天 |
| `engine.ts` | `removeLayer` / `getLayer` 从未被调用 | 顺手删 |

---

## 6b. 做完 19 条之后，还剩下什么

先给结论：**19 条里 17 条已落地，1 条部分（16），1 条未做（19），1 条受环境限制（05）。** 下面按"性价比"排，标注了哪些这一轮已经做掉（`5f712e8`）。

### 值得做的小事（每条 ≤ 半天，风险低）

1. **19 · 领域数据表还在 `canvas/` 里**（唯一完全没动的一条）。`canvas/materials.ts` 被 30 个模块 import、`canvas/room-types.ts` 12 个，`rf/` 和 worker 都在用。它们没有 DOM、没有 state。挪到 `src/lib/domain/`，`ARCHITECTURE.md` 那条"rf 只能 import room-types"才守得住 —— 而且可以用一行 grep 进 CI。**这轮唯一"该做但没做"的条目。**
2. **`shape-preview` 和 `review-highlight` 会进导出图**。它们是瞬态覆盖层（正在画的形状、审阅高亮），但没标 `exportable: false`；`grid` 和 `selection-rect` 标了。各一行。**（未做；这次没碰导出路径。）**
3. **`restoreFromStorage()` 在 `onMount` 里没 await**（`CanvasView:638`）。启动后几十毫秒内的编辑可能被随后的加载覆盖。改成"加载完成前忽略编辑"或者把首个渲染挂在加载之后。**（未做；要动启动顺序，值得单独一轮 + e2e。）**
4. ✅ **`migrate` 接受 `version >= 2` 却按 v3 重写** —— 现在高于 `DOCUMENT_VERSION` 一律拒绝，且**存储里那条记录不再被删除**（原来"读不了"会 `remove`，等于把"打不开"变成"没了"）。导入文件时也会报出实际版本号而不是"invalid"。
5. ✅ **`forgetFloorplan` 只挂在两个 UI 入口上** —— 改成 `floor-state` 的 `onFloorRemoved` 回调，`persistence` 注册（它读 `floor-state`，反向 import 会成环）。任何删楼层路径都会带走底图的存储键。
6. ✅ **多 restart 时没有进度** —— 进度回调不再因 `apply: false` 提前返回：进度跟着每个 pass 走，**分数**仍然只由会被保留的那个 pass 写。

### 中件（各需一轮）

7. **16 的后半**：`CanvasView` 那 40 个 effect 的模板收拢（`LayerSpec`）。结构性危害已经消掉（见 16），剩下的是"读三个字段 → 赋给图层 → markDirty"这类重复；每一条都要人工核对语义，e2e 未必抓得住漏同步。
8. ✅ **`OptimizeMessage` / `OptimizeResult` 两边各声明一次** —— `OptimizeMessage`/`WireMessage`/`OptimizeResult`/`OptimizeProgress`/`WorkerReply` 全部收进 `optimizer-protocol.ts`。**顺带修掉一个真 bug**：桥的 `optimize()` 参数原本是自己写的一份弱类型（id/位置/半径/频段/信道），调用方可以传一个**没有天线字段**的 AP，worker 就会按"直立全向"打分 —— 现在参数类型是 `ApInput`，缺字段编译不过。
9. ⚠️ **`optimizer-worker.ts` 拆了第一刀**：`buildFixedPaths`（109 行，每样本每固定 AP 的行）搬进 `workers/optimizer/fixed-paths.ts`，worker 从 2317 行降到 2103 行。评估器/搜索/汇报三段的大缝还在 —— 它们共用 `runOptimization` 的二十几个局部变量和模块级的状态机，下一刀要从那里切，不是纯搬家。
10. ✅ **`decodeMask` / `encodeMask` 现在有测试** —— 用最小 canvas 垫片（`mask-codec.test.ts`，4 条）：红通道 > 128 算墙、alpha 被写、装不出来的图当空平面而不是报错。

### 仪器类（不影响产品，但影响"敢不敢改"）

11. **golden 基线自 2026-10-15 未重新生成**，6 个 golden 全红。要么 `UPDATE_GOLDEN=1` 并人工看图，要么查 office-300sqm 的 IoU 0.60（幅度不像阈值微调）。
12. **干扰读数没有自动断言**：面板刻意不显示它，所以 e2e 抓不到；目前"报告里的数字 = 外部仪器算的数字"只靠构造保证。要锁住得把它暴露到 DOM 或加一条读 PDF 文本的断言。
13. **`tests/measure` 的 `layout-*` 三个场景只打印面板覆盖率**，没有和外部模型对照的断言。

---


## 7. 明确不建议做的三件事

1. **别把三个评估器合并成一个函数。** 它们的分歧（场 vs 步进、stride 1/2/3）是性能决策，不是重复代码。该做的是第 13 条：**收敛"怎么算一段墙"，保留"在哪采样"**。
2. **别一次性重写 `CanvasView`。** 它每周都在改（34/92 次提交），一次大重写会让所有在途改动冲突。按第 16 条分三步抽。
3. **别先做性能优化。** 目前没有帧率/耗时的基线数据；热力图那几处 per-texel 分配（每 texel 建一个 `WallRun` 对象、每 texel 一个新数组）看起来吓人，但在有测量之前动手，很可能优化了不在关键路径上的东西。先加测量（`log.ts` 的 `debug` 已经支持），再动。

---

## 8. 怎么判断改对了

每条都有自己的验证方式（上面写了），但整体上有一组"回归红线"，建议每批改动之后都跑：

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 类型 | `pnpm check` | 0 errors |
| 单测（含三个 package） | `pnpm test` | 全绿 |
| 端到端 | `pnpm test:e2e` | 105 绿 |
| 视觉基线 | `pnpm test:visual` | 无差异（改了渲染才需要重新生成） |
| 物理基线 | `pnpm --filter . exec vitest run tests/measure` | 数字在容差内 |

**特别提醒**：第 06、07、13 条都会**改变算出来的数字**。这三条必须配合 `tests/measure/` 里的基线一起做，并且把"改前 / 改后"的数字记在 PR 描述里——否则你无法区分"修好了"和"算错了"。

---

## 附：本文档的证据来源

每条的行号来自 `main` @ `e9aff4c`（2026-10-30）。如果你读的时候行号对不上（这是当前周更 17 次的仓库），用函数名或代码片段搜索，不要信行号。
