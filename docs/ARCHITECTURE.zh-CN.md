# Aetherax 代码架构说明

适用版本：0.1.0。本文按当前仓库结构编写，覆盖应用源码、工作区包、测试、脚本、静态资源和桌面外壳。

## 1. 总体结构

Aetherax 是 SvelteKit 静态单页应用，外面套 Tauri v2 桌面窗口。没有服务端、账号或运行时网络依赖。

```
src-tauri/        Tauri 窗口、安装包配置、Rust 入口
src/              SvelteKit 应用
  routes/         页面入口
  lib/
    components/   界面组件
    canvas/       画布引擎、图层、渲染器、交互、检测
    state/        应用状态、持久化、优化器、求解器
    rf/           纯 RF 计算
    workers/      Web Worker 与协议
    data/         AP 型号与厂商表
    domain/       墙体材质、房间类型
    export/       JSON、PDF、PNG 导出
    theme/        设计令牌
packages/         可独立测试的工作区包
  channels/       频段、信道、监管域、吞吐
  geometry/       距离、相交、变换、干扰图
  solver/         信道着色算法与 worker
  tsconfig/       共享 TypeScript 配置
tests/            Playwright e2e、视觉、测量
static/           字体、示例平面图、帮助页面
scripts/          构建与桌面验证脚本
tooling/          ESLint 共享配置
docs/             架构、手册、测量与修复计划
```

依赖方向：

- `rf/` 只依赖 `domain/` 和纯几何，不读状态、DOM、画布。
- `canvas/renderers/` 只负责绘制，不负责决定或保存。
- 楼层数据的唯一来源是 `Floor`；`wallState`、`floorplanState` 是当前楼层的视图。
- 项目文件只有一套 schema：`state/project-document.ts`。
- Worker 的 payload 类型从状态类型派生，不在 worker 里另写一份。

各节目的录：

| 目录 | 内容 |
| --- | --- |
| `.github/workflows` | CI 配置。 |
| `.vscode` | 编辑器推荐插件与设置。 |
| `src/routes` | 页面入口与布局。 |
| `src/lib` | 应用全部逻辑。 |
| `src/lib/canvas` | 画布引擎、渲染器、交互、墙体与平面图检测。 |
| `src/lib/canvas/interactions` | 拖动、放置、选择、平移缩放。 |
| `src/lib/canvas/renderers` | 所有画布图层。 |
| `src/lib/components` | Svelte 界面组件。 |
| `src/lib/components/canvas` | 画布工具栏、弹窗与主视图。 |
| `src/lib/components/dialogs` | 新建、欢迎、确认、帮助弹窗。 |
| `src/lib/components/layout` | 应用外壳、顶栏、侧栏、状态栏、提示。 |
| `src/lib/components/shared` | 通用按钮、下拉、输入、图标等。 |
| `src/lib/components/sidebar` | Floorplan/APs 标签页与覆盖率面板。 |
| `src/lib/data` | AP 型号与厂商数据。 |
| `src/lib/domain` | 墙体材质与房间类型。 |
| `src/lib/export` | JSON、PDF、PNG 导出。 |
| `src/lib/rf` | 纯 RF 物理计算。 |
| `src/lib/state` | 应用状态、持久化、优化器与求解器。 |
| `src/lib/theme` | 设计令牌。 |
| `src/lib/workers` | Web Worker、协议、桥接与优化器子模块。 |
| `packages` | 可独立测试的频段、几何、求解包。 |
| `tests/e2e` | 端到端测试。 |
| `tests/measure` | 性能与收益测量。 |
| `tests/visual` | 检测器黄金图。 |
| `scripts` | 构建手册、字体、桌面验证。 |
| `static` | 字体、示例图、帮助页面。 |
| `src-tauri` | 桌面外壳与打包。 |
| `tooling` | 共享 ESLint 配置。 |
| `docs` | 架构、手册、测量、修复计划。 |

表格中的文件名相对于该节标题的目录。

## 2. 根目录文件

| 文件 | 作用 |
| --- | --- |
| `README.md` | 项目简介、启动方式、构建与验证命令。 |
| `package.json` | 根包脚本、依赖、工作区入口。 |
| `pnpm-lock.yaml` | pnpm 依赖锁定。 |
| `pnpm-workspace.yaml` | 声明 `packages/*` 为工作区包。 |
| `svelte.config.js` | SvelteKit 配置：adapter-static、SPA fallback `index.html`、路径别名。 |
| `vite.config.ts` | Vite 配置：Svelte 插件、worker 格式、测试项目、开发端口。 |
| `tsconfig.json` | 应用 TypeScript 配置，继承共享配置并声明路径别名。 |
| `eslint.config.js` | 根 ESLint 配置，合并共享规则并限制 `rf/`、`domain/` 的导入。 |
| `playwright.config.ts` | e2e、视觉、测量项目的浏览器与 webServer 配置。 |
| `.gitignore` | 忽略构建产物、依赖、测试结果、Tauri 生成文件。 |
| `.vscode/extensions.json` | 推荐编辑器插件。 |
| `.vscode/settings.json` | 编辑器格式与文件关联设置。 |
| `.github/workflows/ci.yml` | CI：安装依赖、svelte-check、单元测试、lint、构建。 |
| `.github/workflows/release.yml` | Windows 打包：推送 `main` 与每个 PR 产出安装包与便携 exe 的构建产物，推送 `v*` 标签发布 GitHub Release；构建前校验三处版本号一致。 |

## 3. `src/routes`

| 文件 | 作用 |
| --- | --- |
| `+layout.ts` | 关闭 SSR、开启 prerender，输出静态 SPA。 |
| `+layout.svelte` | 加载全局样式、字体和页面外壳。 |
| `+page.svelte` | 渲染 `AppShell`，是应用唯一页面。 |

## 4. `src` 根文件

| 文件 | 作用 |
| --- | --- |
| `app.html` | HTML 模板，设置语言、主题色、挂载点。 |
| `app.css` | 全局样式、布局变量、滚动条、通用控件基础样式。 |
| `src/lib/log.ts` | 调试日志开关；构建时默认静默，e2e 构建开启。 |
| `src/lib/units.ts` | 米/英尺显示与输入换算、长度单位提示。 |
| `src/lib/ap-advice.ts` | 根据覆盖率、AP 数量、干扰生成放置建议。 |
| `src/lib/ap-advice.test.ts` | 验证放置建议的阈值与文案分支。 |
| `src/lib/motion.ts` | 动画时长与 `prefers-reduced-motion` 判定，供弹窗过渡使用。 |
| `src/lib/units.test.ts` | 验证长度单位选择、显示与输入换算。 |

## 5. `src/lib/canvas` 根模块

| 文件 | 作用 |
| --- | --- |
| `accents.ts` | 画布统一强调色，用于当前楼层、选中对象、边界与高亮。 |
| `boundary-detect.ts` | 从平面图检测建筑外轮廓多边形与面积；包含 SVG 文本清理。 |
| `camera.ts` | 画布相机：平移、缩放、屏幕与世界坐标转换。 |
| `detect-floorplan.ts` | 选择矢量或像素检测器并返回墙体、材质、边界结果。 |
| `engine.ts` | 画布引擎：图层列表、脏标记、requestAnimationFrame 渲染循环。 |
| `fit.ts` | 按当前视图内容计算并设置相机，供 Fit、视图切换和 PDF 导出使用。 |
| `floor-materials.ts` | 楼板/天花材质表及各频段衰减。 |
| `gestures.svelte.ts` | 指针、触摸、轨道旋转、对齐拖动的状态机。 |
| `heatmap-ramp.ts` | 信号强度颜色渐变，供热力图和天线图共用。 |
| `heatmap-sources.ts` | 组装当前楼层热力图 AP 列表，包含跨层虚拟 AP。 |
| `hit-test.ts` | 点击命中 AP 的屏幕半径测试。 |
| `import-floorplan.ts` | 平面图导入流程：检测、写入状态、提取墙线、保存。 |
| `mask-codec.ts` | 墙体掩膜 PNG 的编码、解码与材质掩膜解码。 |
| `mask-pipeline.svelte.ts` | 当前楼层掩膜解码、房间标签、室内范围计算并发布到图层。 |
| `mask-registry.ts` | 用对象身份生成掩膜签名，供派生缓存失效。 |
| `morphology.ts` | 膨胀、腐蚀、连通域、建筑内部洪水填充。 |
| `region-labels.ts` | 连通区域标记、材质掩膜解码、区域操作。 |
| `rooms.ts` | 房间域的唯一推导参数，供覆盖率、优化器、画布标签共用。 |
| `shortcuts.ts` | 键盘映射：撤销、删除、模式退出、图层开关、保存。 |
| `svg-walls.ts` | 从 SVG 读取墙段、应用变换、处理开口合并。 |
| `tiled-mask.ts` | 稀疏 256×256 分块掩膜，支持负坐标与无限画布。 |
| `types.ts` | `Layer`、`RenderContext` 等画布公共类型。 |
| `vector-detect.ts` | 把分类后的矢量元素合成为墙体掩膜与材质掩膜。 |
| `vector-elements.ts` | 解析 SVG 元素并分类为墙、门、窗、家具、文字。 |
| `wall-detect.ts` | 从位图阈值、形态学与连通域检测墙体。 |
| `wall-distance.ts` | 精确欧氏距离变换，返回最近墙距离与墙位置。 |

### 5.1 `canvas` 根目录测试

| 文件 | 作用 |
| --- | --- |
| `engine.test.ts` | 验证图层渲染链、异常图层重试与脏标记。 |
| `heatmap-ramp.test.ts` | 验证信号色标的停靠点与透明度。 |
| `mask-codec.test.ts` | 验证掩膜 PNG 编解码与材质通道。 |
| `morphology.test.ts` | 验证建筑内部填充、孔洞与边界处理。 |
| `notes.test.ts` | 验证标注点击命中。 |
| `rooms.test.ts` | 验证房间域的分区、阈值和标签一致性。 |
| `seal-openings.test.ts` | 验证门洞封闭的形态学处理。 |
| `svg-openings.test.ts` | 验证 SVG 开口折叠与门窗合并。 |
| `svg-walls.test.ts` | 验证 SVG 变换解析与墙段提取。 |
| `tiled-mask.test.ts` | 验证分块掩膜边界、负坐标、物化。 |
| `vector-detect.test.ts` | 验证角色掩膜合成与开口处理。 |
| `vector-elements.test.ts` | 验证 SVG 元素命名与分类。 |
| `wall-distance.test.ts` | 验证距离变换结果与最近墙坐标。 |
| `wall-fill.test.ts` | 验证双线墙体内部空腔的封闭。 |

## 6. `src/lib/canvas/interactions`

| 文件 | 作用 |
| --- | --- |
| `drag.ts` | 拖动 AP、吸墙、跟随墙面转向、撤销快照。 |
| `pan-zoom.ts` | 滚轮缩放、鼠标中键平移。 |
| `place.ts` | 点击放置 AP：室内校验、挂墙吸附、创建并选中。 |
| `select.ts` | 点击选择、Shift 多选、空白拖框选择。 |

## 7. `src/lib/canvas/renderers`

| 文件 | 作用 |
| --- | --- |
| `ap.ts` | 绘制 AP 标记、覆盖半径、名称、距离标注与选中光晕。 |
| `boundary.ts` | 绘制自动识别的建筑轮廓。 |
| `calibration-line.ts` | 绘制标定线的两个端点与连线。 |
| `floor-3d.ts` | 单层 3D 视图：墙体拉伸、材质、抬升面、AP 高度。 |
| `floor-card.ts` | 多层视图共用卡片缓存：底图、掩膜、覆盖率图、AP 点。 |
| `floor-tiles.ts` | 平铺视图布局、卡片框、点击命中。 |
| `floorplan.ts` | 底图渲染与透明度。 |
| `grid.ts` | 米制网格与比例尺。 |
| `heatmap-region.ts` | 计算热力图图像的世界矩形、texel 与裁剪范围。 |
| `heatmap.ts` | 热力图生成、缓存、跨层路径、抬升面与裁剪。 |
| `notes.ts` | 标注图钉、文本与选中状态。 |
| `planning-area.ts` | 已确认规划范围与绘制中草稿的多边形。 |
| `reference-floor.ts` | 下一层平面/掩膜的半透明参考图。 |
| `review-highlight.ts` | 墙体检测元素复核时的高亮。 |
| `room-labels.ts` | 房间类型标签与自定义标签。 |
| `selection-rect.ts` | 框选矩形。 |
| `shape-preview.ts` | 画墙、柱子、圆形的预览。 |
| `stacked-floors.ts` | 堆叠视图布局、相机、楼层板、AP 高度标记。 |
| `surfaces.ts` | 抬升面的填充、边缘、选中与高度标签。 |
| `vector-walls.ts` | 墙体线段、柱子、选中与材质颜色。 |
| `walls.ts` | 墙体掩膜着色与按材质着色。 |

### 7.1 渲染器测试

| 文件 | 作用 |
| --- | --- |
| `heatmap-region.test.ts` | 验证热力图范围、AP 可达半径、texel 预算与规划范围。 |
| `stacked-floors.test.ts` | 验证堆叠投影、层高、AP 标记与墙板方向。 |

## 8. `src/lib/components/canvas`

| 文件 | 作用 |
| --- | --- |
| `CanvasView.svelte` | 画布主组件：引擎挂载、图层注册、状态同步、编辑动作、导出钩子。 |
| `LayerPanel.svelte` | 图层开关、底图透明度、视图角度、信号色标。 |
| `ApPlacementToolbar.svelte` | 放置 AP 时的顶部工具栏：安装方式、提示、Done。 |
| `WallToolbar.svelte` | 墙体工具：墙/柱、矩形/圆形、擦除、材质、清空、Done。 |
| `SurfaceToolbar.svelte` | 抬升面工具：类型、材质、Done。 |
| `PlanningToolbar.svelte` | 规划范围工具：角点数、撤销、取消、确认。 |
| `CanvasPopup.svelte` | 画布内弹窗的定位与关闭容器。 |
| `WallMaterialPopup.svelte` | 墙体材质选择与自定义材质添加。 |
| `RoomTypePopup.svelte` | 房间类型、密度、自定义标签编辑。 |

## 9. `src/lib/components/dialogs`

| 文件 | 作用 |
| --- | --- |
| `ConfirmDialog.svelte` | 通用确认框。 |
| `NewProjectDialog.svelte` | 新建工程：名称、清空当前布局、创建。 |
| `WelcomeDialog.svelte` | 首次启动引导与示例入口。 |
| `ManualDialog.svelte` | 帮助弹窗，用 iframe 加载 `static/manual.html`。 |

## 10. `src/lib/components/layout`

| 文件 | 作用 |
| --- | --- |
| `AppShell.svelte` | 应用外壳：工具栏、画布、侧栏、状态栏的网格布局。 |
| `Toolbar.svelte` | 顶部栏：工程名、文件菜单、撤销重做、单位、语言、帮助、侧栏。 |
| `Sidebar.svelte` | 侧栏：Floorplan/APs 标签页、覆盖率、建议、AP 列表或编辑器。 |
| `StatusBar.svelte` | 底部状态栏：缩放、Fit、四种视图切换。 |
| `NoticeToast.svelte` | 保存提示、放置提示、楼层外警告与关闭按钮。 |

## 11. `src/lib/components/shared`

| 文件 | 作用 |
| --- | --- |
| `Button.svelte` | 主/次/危险按钮变体。 |
| `Badge.svelte` | 小标签。 |
| `Dropdown.svelte` | 工具栏文件菜单。 |
| `Icon.svelte` | 内联 SVG 图标集合。 |
| `ModelPicker.svelte` | AP 型号选择器。 |
| `NumberInput.svelte` | 带步进与范围的数字输入。 |
| `Select.svelte` | 统一样式的下拉框。 |
| `Toggle.svelte` | 开关。 |
| `Tooltip.svelte` | 悬浮提示。 |

## 12. `src/lib/components/sidebar`

| 文件 | 作用 |
| --- | --- |
| `FloorplanControls.svelte` | Floorplan 标签页：导入、比例、楼层属性、规划范围、墙体、抬升面。 |
| `FloorStrip.svelte` | 楼层条：切换、新增、重命名、排序、删除。 |
| `WallDetectionPanel.svelte` | 矢量/像素检测结果、元素角色复核、改用像素识别。 |
| `ComparePanel.svelte` | 栅格与矢量墙体模型的对比读数；当前未被页面引用。 |
| `FloorplanSurfaces.svelte` | 抬升面参数、材质、绘制与清空。 |
| `FloorplanNotes.svelte` | 标注列表、添加、编辑、删除。 |
| `CoveragePanel.svelte` | 覆盖率、整栋平均、放置模式、优化器设置与运行。 |
| `ApAdvicePanel.svelte` | 放置建议卡片与关闭。 |
| `ApList.svelte` | AP 列表、全选、删除、清空、吞吐显示。 |
| `ApEditor.svelte` | AP 编辑：型号、频段、宽度、信道、功率、安装、天线、方向、Pin。 |
| `AntennaDiagram.svelte` | AP 天线方向图与覆盖柱状示意。 |
| `PanelCard.svelte` | 侧栏卡片外壳：标题、折叠、图标。 |

## 13. `src/lib/data`

| 文件 | 作用 |
| --- | --- |
| `ap-models.ts` | 聚合厂商 AP 型号、查询与默认值。 |
| `vendors/aruba.ts` | Aruba AP 型号表。 |
| `vendors/cisco.ts` | Cisco AP 型号表。 |
| `vendors/consumer.ts` | 消费级路由器/AP 型号表。 |
| `vendors/enterprise.ts` | 通用企业级型号表。 |
| `vendors/ruckus.ts` | Ruckus 型号表。 |
| `vendors/tp-link.ts` | TP-Link 型号表。 |
| `vendors/ubiquiti.ts` | Ubiquiti 型号表。 |

## 14. `src/lib/domain`

| 文件 | 作用 |
| --- | --- |
| `materials.ts` | 墙体材质表：名称、各频段单次穿墙损耗、颜色。 |
| `room-types.ts` | 房间类型目录、分类、默认人员密度、空房间判定。 |
| `room-types.test.ts` | 验证房间类型 ID、密度与类别。 |

## 15. `src/lib/export`

| 文件 | 作用 |
| --- | --- |
| `json.ts` | 工程 JSON 导出与导入，内联平面图 data URL。 |
| `pdf.ts` | 横向 A4 报告：封面、每层截图、AP 清单、覆盖率、结论。 |
| `png.ts` | 当前画布按 2 倍分辨率导出 PNG。 |
| `json.test.ts` | 验证工程 JSON 往返与字段完整性。 |

## 16. `src/lib/rf`

| 文件 | 作用 |
| --- | --- |
| `antenna.ts` | 天线垂直切面增益，按安装方式与波束宽度计算。 |
| `channel-overlap.ts` | 频段信道重叠查表，供干扰与着色使用。 |
| `cross-floor.ts` | 跨层射线在楼板处的分割与两段路径。 |
| `diffraction.ts` | 墙端单刃衍射损耗。 |
| `interference.ts` | 同信道干扰、争用时间与目标函数项。 |
| `link-budget.ts` | 栅格墙损、跨层墙损、`WallRun` 统一入口。 |
| `material-itu.ts` | ITU-R P.2040 材质损耗模型。 |
| `propagation.ts` | 路径损耗、场景系数、可达距离、覆盖阈值。 |
| `raster-ray.ts` | 对比用的简化栅格射线墙损。 |
| `reflection.ts` | 单次镜面反射功率项。 |
| `slab-crossings.ts` | 把跨层路径的每个楼板边界归属到楼层。 |
| `surface-height.ts` | 抬升面高度场、材质颜色、台阶与坡道插值。 |
| `wall-crossings.ts` | 射线与墙段的相交与矢量墙损。 |
| `wall-model-compare.ts` | 同一批射线比较栅格与矢量墙体模型。 |

### 16.1 RF 测试

| 文件 | 作用 |
| --- | --- |
| `antenna.test.ts` | 验证垂直增益、波束宽度与安装角度。 |
| `atten-field.test.ts` | 验证衰减场缓存键与掩膜标签。 |
| `channel-overlap.test.ts` | 验证信道重叠比例与邻道关系。 |
| `coverage-kernel.test.ts` | 验证阈值以上的覆盖效用。 |
| `cross-floor.test.ts` | 验证跨层分割点与两段比例。 |
| `diffraction.test.ts` | 验证单刃衍射公式与边界。 |
| `field-vs-march.test.ts` | 对比极坐标场与射线行进的墙损。 |
| `interference.test.ts` | 验证干扰距离、重叠与目标项。 |
| `link-budget.test.ts` | 验证墙运行与跨层墙损。 |
| `material-itu.test.ts` | 验证 P.2040 材质损耗。 |
| `noise-floor.test.ts` | 验证热噪声底与带宽换算。 |
| `path-loss.test.ts` | 验证路径损耗场景与距离模型。 |
| `reflection.test.ts` | 验证反射系数与反射路径损耗。 |
| `slab-crossings.test.ts` | 验证楼板边界归属与损失分摊。 |
| `surface-height.test.ts` | 验证抬升面高度、台阶、材质衰减。 |
| `wall-charge-agreement.test.ts` | 验证不同路径对同一面墙收费一致。 |
| `wall-crossings.test.ts` | 验证射线与墙段相交。 |
| `wall-march.test.ts` | 验证墙损行进与材质分段。 |
| `wall-model-compare.test.ts` | 验证两种墙体模型的对比读数。 |

## 17. `src/lib/state`

| 文件 | 作用 |
| --- | --- |
| `app.svelte.ts` | 界面模式、工具互斥、侧栏标签、视图、提示、抬升面草稿。 |
| `ap-state.svelte.ts` | 全楼 AP、频段/宽度/监管域、增删改、半径、挂墙高度、按楼层比例。 |
| `floor-state.svelte.ts` | 楼层数据、当前层、层高、楼板、标高、平移、删除、跨层损耗。 |
| `wall-state.svelte.ts` | 当前层墙体掩膜、材质掩膜、检测会话与复核状态。 |
| `floorplan-state.svelte.ts` | 当前层底图、导入会话、单位制、检测提示。 |
| `canvas.svelte.ts` | 画布引擎引用、AP 选择、悬停、复核高亮。 |
| `history.svelte.ts` | 50 步撤销/重做快照，只含楼层与 AP。 |
| `persistence.svelte.ts` | 本地存储、5 秒防抖自动保存、恢复、平面图键、关闭前落盘。 |
| `storage.ts` | 存储后端抽象：localStorage/IndexedDB 与迁移。 |
| `project-document.ts` | 工程文档唯一 schema：`toDocument`、`migrate`、`applyDocument`。 |
| `project-meta.svelte.ts` | 工程名、ISP、优化器策略、热力图门限、自定义材质。 |
| `floor-scale.ts` | 逐层比例设置、AP 半径换算、跨层比例与掩膜重采样。 |
| `floor-mask.ts` | 按楼层缓存解码后的墙体/材质/房间类型掩膜。 |
| `wall-raster.ts` | 把墙体线段栅格化为掩膜。 |
| `wall-trace.ts` | 从掩膜追踪墙段，导入与重检测共用。 |
| `wall-snap.ts` | 最近墙、吸墙坐标、墙面朝向、挂墙可达距离。 |
| `vector-walls.ts` | 线段墙模型：端点吸附、增删、包围盒。 |
| `calibrate.ts` | 从已知线段长度计算世界单位/米。 |
| `planning-area.ts` | 规划范围点内判定、面积、可用性、覆盖率裁剪。 |
| `ap-interior.ts` | 点击/优化时的建筑内部判定与缓存。 |
| `room-domain.ts` | 房间最小半径阈值，按楼层比例换算。 |
| `custom-materials.ts` | 自定义墙体材质的增删与查询。 |
| `surface-defaults.ts` | 抬升面默认高度、厚度、材质与类型切换规则。 |
| `path-loss-state.svelte.ts` | 传播场景切换，同时重算所有 AP 半径。 |
| `optimizer-state.svelte.ts` | 优化器可观察状态、每层覆盖率缓存与失效。 |
| `optimizer-support.ts` | payload 转换、密度图、跨层楼板列表、功率级别。 |
| `optimizer-coverage.svelte.ts` | 实时覆盖率估计：采样、跨层虚拟 AP、抬升面。 |
| `optimizer.svelte.ts` | 优化运行、worker 调用、多 seed、结果写回、取消。 |
| `solver.svelte.ts` | 信道求解运行、冲突图、比较与自动求解。 |
| `i18n.svelte.ts` | 语言状态、英文字符串键、中文目录。 |

### 17.1 状态测试

| 文件 | 作用 |
| --- | --- |
| `app-modes.test.ts` | 验证工具互斥、草稿清理、模式切换。 |
| `calibrate.test.ts` | 验证线段比例换算。 |
| `coverage-basis.test.ts` | 验证覆盖率缓存键与失效。 |
| `floor-mask.test.ts` | 验证按楼层取掩膜与线段派生。 |
| `floor-scale.test.ts` | 验证逐层比例、跨层换算、掩膜重采样、AP 半径。 |
| `floor-view.test.ts` | 验证当前层视图的读写。 |
| `i18n.test.ts` | 验证翻译目录覆盖全部界面键且无重复。 |
| `mounting.test.ts` | 验证安装高度预设与层高约束。 |
| `optimizer-support.test.ts` | 验证优化器 payload 的逐层单位换算。 |
| `persistence.test.ts` | 验证保存、恢复、平面图键。 |
| `planning-area.test.ts` | 验证点内判定、面积与裁剪。 |
| `project-document.test.ts` | 验证工程文档往返与迁移。 |
| `storage.test.ts` | 验证存储迁移与旧格式。 |
| `translate-floor.test.ts` | 验证楼层平移同时移动平面图、墙体、AP。 |
| `vector-walls.test.ts` | 验证线段端点吸附。 |
| `wall-attach.test.ts` | 验证挂墙附着与可达距离。 |
| `wall-raster.test.ts` | 验证线段栅格化与掩膜原点。 |
| `wall-snap.test.ts` | 验证最近墙、AP 坐标与朝向。 |
| `wall-trace.test.ts` | 验证从掩膜追踪墙段。 |

## 18. `src/lib/theme`

| 文件 | 作用 |
| --- | --- |
| `tokens.css` | 颜色、字体、间距、阴影、层级等设计令牌。 |

## 19. `src/lib/workers`

| 文件 | 作用 |
| --- | --- |
| `optimizer-bridge.ts` | 主线程与优化 worker 的消息、进度、取消、超时。 |
| `optimizer-protocol.ts` | 优化 payload 版本、输入输出类型，从状态类型派生。 |
| `optimizer-worker.ts` | 放置搜索与评估器：候选位置、PSO/坐标下降、评分、功率细化。 |
| `solver-bridge.ts` | 主线程与信道求解 worker 的消息与结果应用。 |

### 19.1 `workers/optimizer`

| 文件 | 作用 |
| --- | --- |
| `types.ts` | 优化器搜索、评估、固定路径共享的类型词汇。 |
| `geometry.ts` | 每次运行复用的几何缓存：掩膜、密度、跨层源。 |
| `fixed-paths.ts` | 不随候选位置变化的固定源路径与楼板数据。 |
| `placement.ts` | 可放置区域、墙缓存、挂墙带、室内吸附。 |
| `profiles.ts` | 每个候选布局下各 AP 的天线方向图。 |
| `deck.ts` | 抬升面对路径的附加损耗。 |
| `random.ts` | 可复现的 seeded PRNG。 |
| `geometry.test.ts` | 验证几何缓存与 payload 复用。 |

### 19.2 Worker 测试

| 文件 | 作用 |
| --- | --- |
| `optimizer-bridge.test.ts` | 验证优化协议版本、消息与错误处理。 |

## 20. `packages/channels`

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包名、导出、测试脚本。 |
| `eslint.config.js` | 包内 lint 配置。 |
| `tsconfig.json` | 包 TypeScript 配置。 |
| `vitest.config.ts` | 包测试配置。 |
| `src/index.ts` | 公开导出频段、重叠、监管、吞吐、调色板。 |
| `src/types.ts` | 频段、信道、宽度、监管域类型。 |
| `src/bands/band-2_4ghz.ts` | 2.4 GHz 信道表与非重叠信道。 |
| `src/bands/band-5ghz.ts` | 5 GHz 信道表、DFS 信道。 |
| `src/bands/band-6ghz.ts` | 6 GHz 信道表与 PSC 信道。 |
| `src/overlap.ts` | 频率范围、信道重叠比例、是否干扰。 |
| `src/palette.ts` | 各 AP/频段的绘图颜色。 |
| `src/regulatory.ts` | FCC/ETSI 可用信道过滤、非重叠信道选择。 |
| `src/throughput.ts` | 各标准、空间流、带宽下的 PHY 速率与吞吐估计。 |
| `tests/band-2_4ghz.test.ts` | 验证 2.4 GHz 信道与重叠关系。 |
| `tests/band-5ghz.test.ts` | 验证 5 GHz 信道、DFS 与宽度。 |
| `tests/band-6ghz.test.ts` | 验证 6 GHz 信道与 PSC。 |
| `tests/overlap.test.ts` | 验证重叠比例与相邻信道判定。 |
| `tests/regulatory.test.ts` | 验证监管域可用信道。 |
| `tests/throughput.test.ts` | 验证吞吐估算。 |

## 21. `packages/geometry`

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包名、导出、测试脚本。 |
| `eslint.config.js` | 包内 lint 配置。 |
| `tsconfig.json` | 包 TypeScript 配置。 |
| `vitest.config.ts` | 包测试配置。 |
| `src/index.ts` | 公开导出点、距离、相交、变换、干扰图。 |
| `src/types.ts` | `Point`、`Circle`、`Rect`、`Matrix2D`。 |
| `src/distance.ts` | 欧氏距离、平方距离、点到线段距离。 |
| `src/intersection.ts` | 圆相交、圆重叠面积、点/矩形判定。 |
| `src/transform.ts` | 2D 仿射矩阵：平移、缩放、求逆、应用。 |
| `src/interference-graph.ts` | 由 AP 位置与半径构建干扰图。 |
| `tests/distance.test.ts` | 验证距离函数。 |
| `tests/interference-graph.test.ts` | 验证干扰图邻接。 |
| `tests/intersection.test.ts` | 验证圆与矩形相交。 |
| `tests/transform.test.ts` | 验证矩阵变换与求逆。 |

## 22. `packages/solver`

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包名、导出、测试脚本。 |
| `eslint.config.js` | 包内 lint 配置。 |
| `tsconfig.json` | 包 TypeScript 配置。 |
| `vitest.config.ts` | 包测试配置。 |
| `src/index.ts` | 公开导出算法、比较器、图、验证器。 |
| `src/types.ts` | 图、求解选项、结果、比较结果。 |
| `src/graph.ts` | 图构建、邻接、度数。 |
| `src/validator.ts` | 校验着色是否合法。 |
| `src/comparator.ts` | 同一图运行四种算法并比较。 |
| `src/worker.ts` | 求解 worker 入口，接收序列化图并返回结果。 |
| `src/algorithms/greedy.ts` | 贪心着色。 |
| `src/algorithms/welsh-powell.ts` | Welsh-Powell 着色。 |
| `src/algorithms/dsatur.ts` | DSATUR 着色。 |
| `src/algorithms/backtracking.ts` | 回溯着色。 |
| `tests/fixtures.ts` | 图与着色测试夹具。 |
| `tests/graph.test.ts` | 验证图工具。 |
| `tests/validator.test.ts` | 验证非法着色检测。 |
| `tests/comparator.test.ts` | 验证算法比较。 |
| `tests/greedy.test.ts` | 验证贪心算法。 |
| `tests/welsh-powell.test.ts` | 验证 Welsh-Powell。 |
| `tests/dsatur.test.ts` | 验证 DSATUR。 |
| `tests/backtracking.test.ts` | 验证回溯算法。 |

## 23. `packages/tsconfig`

| 文件 | 作用 |
| --- | --- |
| `package.json` | 共享配置包声明。 |
| `base.json` | 基础 TypeScript 严格选项。 |
| `svelte.json` | Svelte 应用扩展配置。 |

## 24. `scripts`

| 文件 | 作用 |
| --- | --- |
| `build-manual.mjs` | 把 `docs/MANUAL.zh-CN.md` 渲染为 `static/manual.html`。 |
| `bundle-fonts.ps1` | 下载并整理本地字体。 |
| `verify-desktop.mjs` | 启动构建后的 exe，通过 WebView2 调试端口验证渲染、优化器、手册。 |

## 25. `src-tauri`

| 文件 | 作用 |
| --- | --- |
| `Cargo.toml` | Rust 包、Tauri 依赖、release 编译选项。 |
| `Cargo.lock` | Rust 依赖锁定。 |
| `build.rs` | Tauri 构建脚本。 |
| `tauri.conf.json` | 窗口、构建命令、前端目录、bundle、安全配置。 |
| `capabilities/default.json` | 主窗口权限：core 与 opener。 |
| `.gitignore` | 忽略 Tauri 生成目录与目标文件。 |
| `src/main.rs` | Windows release 无控制台入口，调用 `aetherax_lib::run`。 |
| `src/lib.rs` | Tauri 应用：opener 插件、关闭前通知页面落盘、延迟销毁窗口。 |
| `icons/32x32.png` | 32×32 应用图标。 |
| `icons/64x64.png` | 64×64 应用图标。 |
| `icons/128x128.png` | 128×128 应用图标。 |
| `icons/128x128@2x.png` | 256×256 高分辨率图标。 |
| `icons/icon.png` | 通用应用图标。 |
| `icons/icon.ico` | Windows 图标。 |
| `icons/icon.icns` | macOS 图标。 |
| `icons/StoreLogo.png` | Windows Store 标志。 |
| `icons/Square30x30Logo.png` | Windows 30×30 磁贴。 |
| `icons/Square44x44Logo.png` | Windows 44×44 磁贴。 |
| `icons/Square71x71Logo.png` | Windows 71×71 磁贴。 |
| `icons/Square89x89Logo.png` | Windows 89×89 磁贴。 |
| `icons/Square107x107Logo.png` | Windows 107×107 磁贴。 |
| `icons/Square142x142Logo.png` | Windows 142×142 磁贴。 |
| `icons/Square150x150Logo.png` | Windows 150×150 磁贴。 |
| `icons/Square284x284Logo.png` | Windows 284×284 磁贴。 |
| `icons/Square310x310Logo.png` | Windows 310×310 磁贴。 |

## 26. `static`

| 文件 | 作用 |
| --- | --- |
| `_headers` | 静态托管缓存与安全响应头。 |
| `favicon.svg` | 浏览器标签图标。 |
| `manifest.json` | Web 应用清单：名称、主题色、图标。 |
| `manual.html` | 由脚本生成的中文帮助页面，供 Help 弹窗加载。 |
| `fonts/fonts.css` | 本地字体 `@font-face` 声明。 |
| `fonts/Inter-normal-latin.woff2` | Inter 拉丁字体。 |
| `fonts/Inter-normal-latin-ext.woff2` | Inter 拉丁扩展字体。 |
| `fonts/JetBrainsMono-normal-latin.woff2` | JetBrains Mono 拉丁字体。 |
| `fonts/JetBrainsMono-normal-latin-ext.woff2` | JetBrains Mono 拉丁扩展字体。 |
| `samples/apartment-48sqm.svg` | 48 平方米公寓示例平面图。 |
| `samples/apartment-48sqm.png` | 同一示例的位图版本。 |
| `samples/house-120sqm.svg` | 120 平方米住宅示例。 |
| `samples/house-120sqm.png` | 住宅示例位图。 |
| `samples/office-300sqm.svg` | 300 平方米办公室示例。 |
| `samples/office-300sqm.png` | 办公室示例位图。 |
| `samples/little-white-house.svg` | 小型住宅示例，用于矢量检测回归。 |
| `samples/state-floor.svg` | 州政府楼层示例，用于视觉回归。 |

## 27. `tests/e2e`

| 文件 | 作用 |
| --- | --- |
| `helpers.ts` | e2e 公共种子、放置模式、等待保存、画布操作。 |
| `app-loads.spec.ts` | 首启欢迎窗口、关闭与示例入口。 |
| `load-file.spec.ts` | 从欢迎页加载示例平面图。 |
| `align-drag.spec.ts` | 拖动对齐后楼层位置与落点一致。 |
| `ap-placement.spec.ts` | AP 放置、拖动、选中、删除。 |
| `ap-placement-mode.spec.ts` | 只有放置模式开启时点击才添加 AP；概览隐藏按钮。 |
| `ap-mounting.spec.ts` | 挂墙/吊顶/落地安装与波束宽度对覆盖的影响。 |
| `ap-wall-distance.spec.ts` | AP 到墙距离标注在 AP 两侧都正确。 |
| `ap-inside.spec.ts` | 范围外点击拒绝、警告可关闭。 |
| `ap-pinned.spec.ts` | Pin 的 AP 不被优化器移动，其他 AP 仍移动。 |
| `interference.spec.ts` | 部分重叠的同信道干扰被计量。 |
| `solver.spec.ts` | 信道求解、固定信道、对比算法。 |
| `optimizer.spec.ts` | 单层/整栋优化、进度、取消、设置。 |
| `per-floor-floor.spec.ts` | 每层最低覆盖率约束只提升最弱层。 |
| `path-loss.spec.ts` | 传播场景选择与持久化。 |
| `multi-floor.spec.ts` | 添加、切换、删除楼层与逐层数据。 |
| `floor-3d.spec.ts` | 3D 视图、旋转、楼层切换、墙体高度。 |
| `stacked-view.spec.ts` | 堆叠视图布局、旋转、楼层点击、Only this floor。 |
| `tiled-view.spec.ts` | 平铺卡片、切换楼层、逐层比例、材质颜色。 |
| `stacked-export.spec.ts` | 堆叠视图导出为图片。 |
| `export.spec.ts` | 工程 JSON、PNG、PDF 导出。 |
| `calibration.spec.ts` | 比例标定流程与提示。 |
| `wall-model.spec.ts` | 线段墙、掩膜派生、柱子、材质、删除。 |
| `wall-materials.spec.ts` | 墙体材质选择、自定义材质。 |
| `raised-surfaces.spec.ts` | 平台/楼梯/坡道绘制、材质、覆盖影响。 |
| `room-types.spec.ts` | 房间类型、密度、标签、覆盖率加权。 |
| `notes.spec.ts` | 标注添加、编辑、删除。 |
| `heatmap-after-draw.spec.ts` | 画墙过程中热力图保持显示。 |
| `planning-area.spec.ts` | 规划范围绘制、确认、热力图范围跟随。 |
| `undo-draw.spec.ts` | 墙体工具中 Ctrl+Z 撤销最后一段且保持缩放。 |
| `help-manual.spec.ts` | Help 弹窗、iframe 手册内容与关闭。 |
| `visual-audit.spec.ts` | 关键界面截图，覆盖桌面与移动布局。 |

## 28. `tests/measure`

| 文件 | 作用 |
| --- | --- |
| `drag-cost.spec.ts` | 测量拖动 AP 时覆盖率重算的耗时。 |
| `interference-alternation.spec.ts` | 测量交替优化放置与信道的收益。 |
| `lattice-optimum.mjs` | 在离散网格上枚举最优放置，作为测量基准。 |

## 29. `tests/visual`

| 文件 | 作用 |
| --- | --- |
| `helpers.ts` | 视觉测试的示例加载、截图与比较工具。 |
| `node-shims.d.ts` | 视觉测试的 Node 类型补充。 |
| `vector-detect.spec.ts` | 真实 SVG 导出形状的矢量检测回归。 |
| `wall-detect.golden.spec.ts` | 每个示例平面图的墙体检测黄金图对比。 |
| `golden/apartment-48sqm.png.png` | 公寓 PNG 检测黄金图。 |
| `golden/apartment-48sqm.svg.png` | 公寓 SVG 检测黄金图。 |
| `golden/house-120sqm.svg.png` | 住宅 SVG 检测黄金图。 |
| `golden/little-white-house.svg.png` | 小住宅 SVG 检测黄金图。 |
| `golden/office-300sqm.svg.png` | 办公室 SVG 检测黄金图。 |
| `golden/state-floor.svg.png` | 州政府楼层 SVG 检测黄金图。 |

## 30. `tooling`

| 文件 | 作用 |
| --- | --- |
| `eslint-config/package.json` | 共享 ESLint 配置包声明。 |
| `eslint-config/index.js` | ESLint 规则集合：TypeScript、Svelte、导入边界。 |

## 31. `docs`

| 文件 | 作用 |
| --- | --- |
| `ARCHITECTURE.zh-CN.md` | 本文，中文架构与逐文件说明。 |
| `MANUAL.zh-CN.md` | 中文使用手册，Help 弹窗的来源。 |

## 32. 关键数据流

### 32.1 墙体

```
Floor.walls / columns
  → wall-raster.ts（栅格化）
  → 墙体掩膜
  → floor-mask.ts（按楼层缓存）
  → 热力图 / 覆盖率 / 优化器 / 室内判定 / 房间标签
```

`getFloorMask(floorId)` 是所有消费者的统一入口：有线段时从线段派生，否则解码存储的 PNG。当前层的编辑由 `MaskPipeline` 发布，其他楼层走缓存。

### 32.2 工程文档

```
toDocument()  状态 → 文档   保存 / JSON 导出
migrate()     任意版本 → 文档   导入 / 恢复
applyDocument() 文档 → 状态
```

新增楼层字段必须同时改 `Floor`、`DocumentFloor`、两个转换函数和往返测试。

### 32.3 优化器

```
CanvasView / CoveragePanel
  → optimizer.svelte.ts（组装 payload、多 seed）
  → optimizer-bridge.ts
  → optimizer-worker.ts（评估 + 搜索）
  → 结果写回 AP
```

覆盖率面板的实时百分比走 `optimizer-coverage.svelte.ts`，它与优化器共享 `optimizer-support.ts` 的转换和 `rf/link-budget.ts` 的墙损。

### 32.4 信道求解

```
AP 图 → solver.svelte.ts → solver-bridge.ts → packages/solver/worker.ts
  → 着色结果 → 写回 AP.assignedChannel
```

## 33. 修改代码时的落点

| 要加的东西 | 放在哪里 |
| --- | --- |
| 新物理项 | `src/lib/rf/<topic>.ts`，配测试；墙损接入 `link-budget.ts` |
| 新楼层字段 | `Floor` + `DocumentFloor` + 文档转换 + 往返测试 |
| 新优化器输入 | `optimizer-protocol.ts` → `optimizer-support.ts` → worker |
| 新图层 | `canvas/renderers/*` 实现 `Layer`，在 `CanvasView` 注册 |
| 新绘图工具 | `app.svelte.ts` 模式 + `canvas/interactions/*` + 工具栏 |
| 新界面文案 | 用 `t('English literal')`，同时在 `i18n.svelte.ts` 补中文 |
| 新导出格式 | `export/*`，工程数据一律经 `toDocument` |

## 34. 测试与构建

| 命令 | 内容 |
| --- | --- |
| `pnpm check` | svelte-check 类型检查。 |
| `pnpm test` | 根项目与三个工作区包的 Vitest。 |
| `pnpm lint` | ESLint。 |
| `pnpm build` | 生成静态站点，并先重建帮助页面。 |
| `pnpm test:e2e` | Playwright 端到端，115 个用例。 |
| `pnpm test:visual` | 检测器黄金图对比。 |
| `pnpm test:measure` | 性能与模型测量，输出数字。 |
| `pnpm verify:desktop` | 启动构建后的 exe 做真实 WebView 验证。 |
