/**
 * Interface language.
 *
 * **The English source string is the key.** That keeps the change to a component to wrapping
 * the literal it already has (`t('Import Floorplan')`), and it makes a missing translation
 * degrade to English rather than to a key name — which matters because there is no compiler
 * check that a catalogue keeps up with the interface.
 *
 * Two locales: `en` and Simplified Chinese (`zh`). The choice persists in `localStorage`
 * beside the project, and `document.documentElement.lang` follows it so the browser stops
 * offering to translate a page that is already Chinese.
 *
 * Deliberately *not* translated here: the PDF report and the optimiser's console lines. The
 * report is a document a user hands to somebody else and its numbers are the ones recorded in
 * `docs/PHYSICAL_MODELS.md`; the console lines are read against those documents.
 */
export type Locale = 'en' | 'zh';

const STORAGE_KEY = 'aetherax:locale';

export const i18nState = $state<{ locale: Locale }>({ locale: 'en' });

/** Chinese translations, keyed by the English string. */
const zh: Record<string, string> = {
	// ── chrome: toolbar, sidebar, status bar ─────────────────────────────
	File: '文件',
	'New Project': '新建工程',
	'Open Project...': '打开工程…',
	'Save Project': '保存工程',
	'Export Project File...': '导出工程文件…',
	'Export as PNG': '导出 PNG',
	'Export as PDF': '导出 PDF',
	'Click the two ends of a distance you know': '点击图上一条你已知长度的线段两端',
	'First point: click on the plan.': '第一点：在图上点击。',
	'Second point: click the other end.': '第二点：点击另一端。',
	'Now type the real length of that line.': '现在输入这条线的实际长度。',
	'or measure a distance on the plan': '或在图上量一段距离',
	'or measure a distance instead': '或改用量一段距离',
	'That line has no length — click two different points.': '这条线没有长度——请点击两个不同的点。',
	'Set by the ft/m switch in the toolbar.': '单位跟随工具栏的 m/ft 开关。',
	'e.g. 12': '例如 12',
	'Signal strength': '信号强度',
	'Click the corners of this floor (at least three), then press Enter.': '依次点击本层的各个角点（至少三个），然后按 Enter 闭合。',
	'{count} corners — the next click continues the loop; press Enter to close it.': '已有 {count} 个角点——继续点击可延伸轮廓，按 Enter 闭合。',
	'Confirm area': '确认范围',
	'Planning area': '规划范围',
	Drawing: '绘制中',
	'Auto-detected': '自动识别',
	'{count} corners · {area} m²': '{count} 个角点 · {area} m²',
	Notes: '标注',
	'Custom material': '自定义材质',
	'{count} drawn': '已画 {count} 段',
	'Draw wall': '绘制墙体',
	'Clear walls': '清空墙体',
	'Click the start of a wall. Ends snap to walls already drawn.': '点击墙的起点；端点会自动吸附到已画的墙。',
	'Click the far end. Hold Shift to keep it straight, Escape to cancel.': '点击墙的终点；按住 Shift 保持正交，Esc 取消。',
	'Compare wall models': '对比两种墙体模型',
	'Trace from mask': '从掩码自动提取墙线',
	'The mask, the interior and the coverage are derived from these walls. Click a wall to select it, right-click it to change its material.':
		'墙体掩码、室内范围与覆盖率都由这些墙线推导。单击墙体可选中，右键可修改材质。',
	'{count} walls were traced from the plan into segments, so they can be corrected one at a time.':
		'已从图纸中提取 {count} 段墙体，可逐段修改。',
	'is two clicks: the start and the end. Ends and sides snap,': '是两次点击：起点和终点。端点与墙身都会吸附，',
	'holds it straight, and': '保持正交，',
	'removes the selected one. The mask, the interior and the coverage are derived from the walls you draw.':
		'删除选中的墙线。掩码、室内范围与覆盖率都由你画的墙线推导。',
	'and the single / tiled / stacked / 3D views.': '以及单层 / 平铺 / 堆叠 / 三维视图。',
	'Hold Shift to keep a new wall straight': '按住 Shift 让新墙保持正交',
	'{walls} walls · {samples} rays · raster {raster} dB · vector {vector} dB':
		'{walls} 段墙 · {samples} 条射线 · 栅格 {raster} dB · 矢量 {vector} dB',
	'Same walls, both kernels: Δ {mean} dB mean · {count} disagreements':
		'同一批墙、两个内核：平均差 {mean} dB · {count} 处不一致',
	'Δ {mean} dB mean · {max} dB worst · {count} rays where one model has a wall and the other does not':
		'平均差 {mean} dB · 最大差 {max} dB · {count} 条射线上一个模型有墙、另一个没有',
	'Delete material': '删除材质',
	'Loss per crossing': '单次穿墙损耗',
	'Thickness': '厚度',
	'e.g. Lead-lined door': '例如：铅门',
	Add: '添加',
	'{count} on this floor': '本层 {count} 条',
	'Hide the list': '收起列表',
	'Show the list': '展开列表',
	'(empty note)': '（空标注）',
	'Click on the plan to place a note. Escape cancels.': '点击图上位置放置标注，Esc 取消。',
	'What should a reader know about this spot?': '这个位置有什么需要读者知道的？',
	'Delete note': '删除标注',
	'Add note': '添加标注',
	'Undo corner': '撤销一个角点',
	'{count} corners · {area} m² — press Enter to close, Backspace to undo the last corner.': '{count} 个角点 · {area} m² —— 按 Enter 闭合，Backspace 撤销上一个角点。',
	'Draw planning area': '绘制规划范围',
	'Redraw planning area': '重新绘制规划范围',
	'Use the detected area': '改用自动识别的范围',
	'Signal strength scale in dBm': '信号强度色标（dBm）',
	'Below the floor: no usable signal': '低于门限：无可用信号',
	Undo: '撤销',
	Redo: '重做',
	Help: '帮助',
	'Toggle sidebar': '显示/隐藏侧栏',
	'Toggle units': '切换单位',
	'Toggle between imperial (ft) and metric (m) units': '在英制（ft）与公制（m）之间切换',
	'Double-click to rename': '双击改名',
	Language: '语言',
	'Interface language': '界面语言',
	Sidebar: '侧栏',
	Floorplan: '平面图',
	APs: 'AP',
	'Floor view': '楼层视图',
	'Show the current floor only': '只显示当前楼层',
	'Tile every floor side by side. Click a floor to select it.': '各层并排排列，点击某一层选中它。',
	'Stack every floor by its height. Click a floor to select it.': '按层高堆叠，点击某一层选中它。',
	Fit: '适配',
	'Fit to view': '缩放到可见范围',
	Saved: '已保存',
	'Wireless Channel Planner': '无线信道规划器',
	'Drop a floorplan image here': '把平面图拖到这里',

	// ── dialogs ──────────────────────────────────────────────────────────
	'Welcome to Aetherax': '欢迎使用 Aetherax',
	'Get Started': '开始使用',
	'Don\'t show this again': '不再显示',
	'Import a floorplan, place access points, and press':
		'导入平面图、放置 AP，然后按',
	'to see the heatmap.': '查看热力图。',
	'Project name': '工程名称',
	'This will clear the current layout.': '这会清空当前布局。',
	Cancel: '取消',
	Create: '创建',
	Delete: '删除',
	'Untitled Project': '未命名工程',
	Close: '关闭',
	'About Aetherax': '关于 Aetherax',
	'Aetherax 使用手册': 'Aetherax 使用手册',

	// ── panel: coverage and the optimiser ────────────────────────────────
	Coverage: '覆盖率',
	'Whole building': '整栋建筑',
	'Placement optimiser': '放置优化器',
	'Placement optimiser settings': '放置优化器设置',
	'Optimize placement': '优化放置',
	'Optimize all floors': '优化全部楼层',
	'Optimize this floor': '优化本层',
	'Find the best positions for the access points on this floor, keeping how many you placed. The score trades coverage against co-channel interference; both weights are in the optimiser settings.':
		'在保持 AP 数量不变的前提下，为本层 AP 找最佳位置。评分在覆盖率与同信道干扰之间权衡，权重在优化器设置里。',
	'Optimise every floor in turn with the others held fixed, and repeat until the building-wide coverage stops improving. Each floor\'s APs stay on their own storey.':
		'逐层轮流优化（其他层固定不动），重复到整栋覆盖率不再提升。每层的 AP 留在自己那一层。',
	'Optimise only the floor on screen, leaving every other storey exactly where it is. Cheaper than the all-floor run, but its result is scored without the floors it cannot see.':
		'只优化屏幕上这一层，其他层一动不动。比整栋运行便宜，但它的结果是在看不见其他层的情况下评分的。',
	'While this is on, a click on the canvas adds an access point. Escape stops.':
		'打开时，在画布上点一下就会落一个 AP。按 Esc 退出。',
	'Allow APs outside rooms': '允许 AP 放在房间外',
	'Off by default: optimised APs stay inside the detected building interior. Turn on to let them land anywhere, walls included.':
		'默认关闭：优化时 AP 只落在识别出的建筑内部。打开后可以落在任何位置，包括墙上。',
	'Min signal': '最低信号',
	'Signal below this is left transparent, so the coloured area lines up with the coverage circle around each AP. Raise it (e.g. -70 dBm) to show only the strong core.':
		'低于这个电平的区域保持透明，所以涂色范围与每个 AP 的覆盖圆一致。调高（例如 −70 dBm）只看强信号核心。',
	Interference: '干扰权重',
	'How much co-channel interference the optimiser trades against coverage: the score is coverage minus this weight times the share of the floor whose best access point is degraded by a co-channel second one. 0 scores coverage alone — the behaviour before the term existed — so it doubles as the A/B switch.':
		'目标函数里同信道干扰项的权重：分数 = 覆盖率效用 − 权重 × 同信道干扰占比。0 就是「只看覆盖」，也就是这一项存在之前的行为，所以它同时是 A/B 开关。',
	'Min coverage': '最低覆盖率',
	'ε-constraint: the minimum share of the floor the optimiser\'s result must cover. 0 is no constraint, which is the plain coverage-minus-interference trade. Setting a floor makes the requirement explicit — a weighted sum can only walk the convex part of the coverage/interference front, so a floor is how a non-convex stretch, or a guarantee like \'no less than 90%\', gets expressed.':
		'ε-约束：优化结果至少要覆盖的楼面占比。0 表示不约束，就是普通的「覆盖率 − 干扰」加权和。设了下限就等于把要求写明——加权和只能走出前沿的凸的部分，要求「不低于 90%」这种话只能靠下限表达。',
	'Client height': '客户端高度',
	'Height of the client devices above the floor. APs are modelled as ceiling-mounted, so this is the other end of every cross-floor path: it changes both the vertical distance and, through it, the cross-floor loss.':
		'客户端设备离地高度。AP 按吸顶安装建模，所以它是每条跨楼层路径的另一端：既改变垂直距离，也通过距离改变跨层损耗。',
	Restarts: '重跑次数',
	'How many times to run the optimiser on this floor, keeping the best result. Each run starts from a different seed. 1 is fastest; the browser console prints the spread across runs, which says whether the extra ones are buying anything.':
		'在本层重复跑几次，取最好的一次。每次用不同的随机种子。1 最快；浏览器控制台会打印多次运行之间的离散度，用来说明多跑几次值不值。',
	'run(s)': '次',
	Weakest: '最弱',
	floors: '层',
	floor: '层',
	measured: '已测量',
	'below 50%': '低于 50%',

	// ── panel: placement advice ──────────────────────────────────────────
	'Placement advice': '放置建议',
	Dismiss: '关闭',
	'Set the scale': '先设置比例',
	'Add access points': '增加 AP',
	'Remove access points': '减少 AP',
	'Assign channels': '分配信道',
	'Co-channel interference': '同信道干扰',
	'Rebalance the floors': '调整各层分布',
	'Coverage is on target': '覆盖率已达标',
	'Until the plan has a scale, every distance here and every AP range is in world units. Set the floorplan area in the Floorplan tab.':
		'在平面图有比例之前，这里的每个距离和每个 AP 半径都只是世界单位。请到「平面图」标签页填写平面图面积。',
	'Coverage {coverage}% against a {target}% target — about {count} more AP(s) would close the gap.':
		'覆盖率 {coverage}%，目标是 {target}%——大约再加 {count} 个 AP 就能补上差距。',
	'One access point currently covers {area} on average.': '目前平均每个 AP 覆盖 {area}。',
	'Coverage {coverage}%, well past the {target}% target — {count} AP(s) look redundant. Remove one and re-run to confirm the figure holds.':
		'覆盖率 {coverage}%，已经远超 {target}% 的目标——有 {count} 个 AP 可能是多余的。可以先删掉一个再跑一次，确认数值还站得住。',
	'No channel assigned to {count} AP(s) yet — run the channel solver so the interference figure describes this plan.':
		'还有 {count} 个 AP 没有分配信道——先跑一次信道求解，干扰数据才是在描述当前这套方案。',
	'Co-channel interference {interference}% and contended airtime {contention}% — lower TX power on the overlapping APs, or space them further apart.':
		'同信道干扰 {interference}%，争用的空口时间 {contention}%——可以调低重叠 AP 的发射功率，或者把它们拉开一些。',
	'The building average is {building}% but {floor} is at {coverage}% — move an access point there, or run Optimize all floors with the per-floor minimum enabled.':
		'整栋平均 {building}%，但 {floor} 只有 {coverage}%——可以往那一层挪一个 AP，或者勾选「每层都适用」后跑一次「优化全部楼层」。',
	'{count} AP(s) cover {coverage}% of this floor — no change suggested.':
		'{count} 个 AP 覆盖了本层 {coverage}%——暂无调整建议。',
	'Based on the last optimisation run.': '以上基于最近一次优化运行的结果。',

	// ── panel: floorplan controls ───────────────────────────────────────
	'Import Floorplan': '导入平面图',
	'Read from vector geometry': '按矢量几何识别',
	'{walls} walls · {windows} windows · {doors} doors': '{walls} 面墙 · {windows} 扇窗 · {doors} 扇门',
	'{count} fixtures and labels left out of the mask': '已排除 {count} 个洁具／家具／文字标注',
	'{count} unclassified': '{count} 个未分类',
	'{count} changed by you': '你改动了 {count} 个',
	'Read walls from pixels instead': '改用像素方式识别墙体',
	'Read from pixels': '按像素识别',
	'This file is an image, so there are no drawing objects to classify.':
		'这个文件是位图，没有可分类的绘图对象。',
	'The vector reader found nothing wall-shaped in this drawing.':
		'矢量识别在这张图里没有找到任何墙形的元素。',
	'The vector reader could not handle this drawing.': '矢量识别无法处理这张图。',
	'You chose the pixel detector for this plan.': '这张图是你手动选择用像素方式识别的。',
	'Text masking is unavailable, so labels are being read as walls. Re-detect when the text model can be downloaded.':
		'文字屏蔽不可用（文字识别模型没能加载），所以图纸上的文字标注会被当成墙。等能下载模型后重新识别一次。',
	'PDF plans are not supported yet — export the page as a PNG and drop that.':
		'还不支持 PDF 图纸——请先把那一页导出成 PNG 再拖进来。',
	'That file type is not supported — use a PNG, JPEG or SVG.':
		'不支持这种文件格式——请使用 PNG、JPEG 或 SVG。',
	'Check the openings and anything unclassified': '核对门窗和未分类的元素',
	'Treat this element as': '把这个元素当作',
	Reset: '重置',
	Wall: '墙',
	Door: '门',
	Window: '窗',
	'Not a barrier': '不是遮挡物',
	'showing {shown} of {total}': '显示 {total} 个中的前 {shown} 个',
	'That change left no walls at all — undo it or re-detect.':
		'这个改动把墙全部去掉了——撤销它，或者重新识别。',
	'Set by the ft/m switch in the toolbar, which converts what is already typed.':
		'由顶栏的 ft/m 开关决定，并会把已填写的数值一并换算。',
	'Draw from Scratch': '从零手绘',
	'Detect Walls': '识别墙体',
	'Re-detect Walls': '重新识别',
	'Detect walls': '识别墙体',
	'Re-detect walls': '重新识别墙体',
	Loaded: '已加载',
	'Remove floorplan': '移除平面图',
	Scale: '比例',
	'Not set': '未设置',
	'Derived from these walls: the mask, the interior and the coverage.':
		'掩码、室内范围与覆盖率均由这些墙线推导。',
	'Click an outline to select it; Delete removes it.': '单击轮廓可选中，按 Delete 删除。',
	'Measure a distance': '量一段距离',
	'Set the scale by measuring one distance on the plan.': '在图上量一段已知长度来确定比例。',
	'Material': '材质',
	'Material for the next raised surface': '下一个抬升面的材质',
	'Set by the material': '由材质决定',
	'Timber': '木材',
	'Steel': '钢材',
	'{attenuation} dB through the deck': '穿过面层衰减 {attenuation} dB',
	'Hide the area field': '收起面积输入',
	'State the total area instead': '改为填写总面积',
	Line: '直线',
	Rectangle: '矩形',
	Circle: '圆形',
	'Wall tools': '墙体工具',
	Columns: '柱子',
	'Column shape': '柱子形状',
	Erase: '擦除',
	'Material for the next wall or column': '下一段墙 / 柱使用的材质',
	'More…': '更多…',
	'Add floor': '添加楼层',
	Align: '对齐',
	'Align X': 'X 方向',
	'Align Y': 'Y 方向',
	Apply: '应用',
	Skip: '跳过',
	'Click to switch, double-click to rename': '点击切换，双击改名',
	'Detecting boundary...': '正在识别轮廓…',
	'Shift this floor to line it up with the floor below. Moves the plan, the walls and the APs together.':
		'把整层平移，与下一层对齐。底图、墙体、AP 一起移动。',
	'Drag on the canvas to move this floor onto the one below. Moves the plan, the walls and the APs together.':
		'在画布上拖动，把整层叠到下一层上。底图、墙体、AP 一起移动。',
	'Shift this floor sideways to line it up with the floor below. Moves the plan, the walls and the APs together.':
		'把整层左右平移，与下一层对齐。底图、墙体、AP 一起移动。',
	'Ceiling height': '层高',
	'Floor material': '楼板材质',
	'Floor thickness': '楼板厚度',
	Opacity: '不透明度',
	Recalibrate: '重新标定',
	'e.g. 200': '例如 200',
	'Total floor area': '楼面总面积',
	Calibrate: '标定',
	'Room density': '房间密度',
	'Site Area': '场地面积',

	// ── panel: access points ────────────────────────────────────────────
	'ACCESS POINTS': 'AP 列表',
	'All': '全部',
	Clear: '清除',
	'Clear all access points': '清空所有 AP',
	'Delete selected': '删除选中',
	'No access points yet': '还没有 AP',
	'Select all': '全选',
	Name: '名称',
	'AP name': 'AP 名称',
	Model: '型号',
	Band: '频段',
	Channel: '信道',
	'Channel Width': '信道宽度',
	'TX Power': '发射功率',
	Position: '位置',
	Auto: '自动',
	'Clear name': '清空名称',
	'Delete Access Point': '删除该 AP',
	'Delete All': '全部删除',
	Deselect: '取消选中',
	'2.4 GHz': '2.4 GHz',
	'5 GHz': '5 GHz',
	'6 GHz': '6 GHz',
	'20 MHz': '20 MHz',
	'40 MHz': '40 MHz',
	'80 MHz': '80 MHz',
	'160 MHz': '160 MHz',
	'320 MHz': '320 MHz',
	'Search models...': '搜索型号…',
	'Decrease': '减小',
	'Increase': '增大',

	// ── canvas: layers, tools, room types ───────────────────────────────
	Layers: '图层',
	'Signal heatmap': '信号热力图',
	'Walls': '墙体',
	'Access points': 'AP',
	'Room labels': '房间标签',
	Labels: '标签',
	Grid: '网格',
	'Floor below': '下一层地图',
	Floor: '楼层',
	'Floor above': '上一层',
	'The current floor in 3D: walls at their real height, in their material colours. Drag to turn the view.':
		'当前楼层的三维视图：墙体按真实高度与材质颜色显示，拖动可旋转视角。',
	'Plan opacity': '底图不透明度',
	'Floor plan opacity': '底图不透明度',
	'Stack rotation': '堆叠旋转',
	'Stack spacing': '堆叠间距',
	'Stack tilt': '堆叠俯仰',
	Rotate: '旋转',
	Spacing: '间距',
	Tilt: '俯仰',
	'Only this floor': '只看本层',
	Excellent: '优秀',
	Good: '良好',
	Fair: '一般',
	Poor: '较差',
	Dead: '无信号',
	'Clear all': '全部清除',
	Done: '完成',
	'Channel planning canvas': '信道规划画布',
	'Room type': '房间类型',
	Density: '密度',
	'Search rooms...': '搜索房间…',
	'No matching room types': '没有匹配的房间类型',
	'Custom label...': '自定义标签…',
	'Clear label': '清除标签',

	PROPERTIES: '属性',
	'What is the total area of the floorplan?': '平面图的总面积是多少？',
	'click the canvas': '在画布上点击',
	'or try a sample:': '或者试试样例：',

	// ── generated: every remaining key the collector found ───────────────
	// ── help ────────────────────────────────────────────────────────────
	SHORTCUTS: '快捷键',
	'GETTING STARTED': '上手',
	'THE NUMBERS': '读数',
	SETTINGS: '设置',
	SOURCES: '出处',
	Heatmap: '热力图',
	'Remove selected APs (Backspace too)': '删除选中的 AP（Backspace 也可以）',
	'Leave place or align mode': '退出放置 / 对齐模式',
	'Place APs': '放置 AP',
	'Place APs is a mode, off by default: turn it on (top of the sidebar), click the plan, Esc to leave.':
		'「放置 AP」是一个模式，默认关闭：打开它（侧栏顶部），在图上点一下落一个，按 Esc 退出。',
	'Click a wall for its material; right-click a room for its type and density.':
		'左键点墙改材质；右键点房间设置类型与密度。',
	'Tap a wall for its material; long-press a room for its type.':
		'点墙改材质；长按房间设置类型。',
	'Detect Walls turns the imported plan into a wall mask; Re-detect replaces it and clears every material you painted, so it asks first.':
		'「识别墙体」把导入的图变成墙体掩码；「重新识别」会替换它并清掉你刷过的材质，所以会先问一次。',
	'Add floors in the Floorplan tab. The status bar holds zoom, Fit and the single / tiled / stacked views.':
		'在「平面图」标签页里加楼层。状态栏有缩放、适配，以及单层 / 平铺 / 堆叠三种视图。',
	'Optimize placement works on the floor on screen; Optimize all floors does every storey and moves the building figure; Export PDF writes the report.':
		'「优化放置」只管屏幕上这一层；「优化全部楼层」逐层都做，会改动整栋数字；「导出 PDF」生成报告。',
	'Coverage — the panel\'s one reading: floor share inside some access point\'s coverage circle.':
		'覆盖率——面板上唯一的读数：落在某个 AP 覆盖圆内的楼面占比。',
	'Co-channel — floor share whose best access point is within 10 dB of a same-channel second one. The score trades this against coverage, at the Interference weight.':
		'同信道——最强 AP 与同信道次强 AP 相差 10 dB 以内的楼面占比。目标函数按「干扰权重」拿它和覆盖率做权衡。',
	'Share airtime (clear-channel assessment) — floor share where two overlapping-channel access points are both above ≈ −82 dBm, so stations defer to one another. Reported, never optimised; a plan can read 0% and 100%, and that pair is the honest picture.':
		'共享空口时间（CCA）——两个信道重叠的 AP 都强于约 −82 dBm 的楼面占比，此时站点会互相退避。只报告、不优化：一份方案可以读 0% 与 100%，这一对数字才是诚实的全貌。',
	'Both are off the panel on purpose: they describe a run, so each run prints them (co-channel interference … %, contended (CCA) … %) and the PDF cover repeats them — before a run scores the plan, the line calls the figure an all-co-channel bound.':
		'这两个数字有意不放在面板上：它们描述的是一次运行，所以每次运行都会打印（co-channel interference … %, contended (CCA) … %），PDF 封面也会重复一遍——还没跑过之前，那行会把它标成「所有 AP 同信道」的上界。',
	'Behind the gear next to Placement optimiser: Interference (how much co-channel is traded against coverage; 0 scores coverage alone) · Min coverage (ε-constraint: the result must cover at least this much; 0 = off) · Restarts (how many seeds to try, best kept) · Min signal (heatmap floor; below it stays transparent) · Client height and Allow APs outside rooms.':
		'在「放置优化器」旁边的齿轮里：干扰权重（拿多少同信道去换覆盖率；0 = 只看覆盖）·最低覆盖率（ε-约束：结果至少覆盖这么多；0 = 关闭）·重跑次数（试几个种子，取最好）·最低信号（热力图下限，低于它保持透明）·客户端高度、允许 AP 放在房间外。',

	// ── help dialog, rest of it ─────────────────────────────────────────
	'Add floors': '添加楼层',
	'Click a wall': '点墙',
	'Ctrl/⌘+Shift+Z': 'Ctrl/⌘+Shift+Z',
	'Ctrl/⌘+Z': 'Ctrl/⌘+Z',
	'Esc': 'Esc',
	'Escape': 'Esc',
	'Export PDF': '导出 PDF',
	'Re-detect': '重新识别',
	'Shift': 'Shift',
	'right-click a room': '右键点房间',
	'Advanced': '高级',
	'devices/m²': '设备/m²',
	'Optimizing…': '优化中…',

	// ── data names: rooms, their canvas labels, categories, materials ───
	'Drywall': '干墙',
	'Wood': '木质',
	'Glass': '玻璃',
	'Brick': '砖墙',
	'Concrete': '混凝土',
	'Metal': '金属',
	'Virtual Partition': '虚拟隔断',
	'Commercial': '商业',
	'Residential': '住宅',
	'Education': '教育',
	'Healthcare': '医疗',
	'Hospitality': '酒店餐饮',
	'Industrial': '工业',
	'Custom': '自定义',
	'Hallway': '走廊',
	'Stairwell': '楼梯间',
	'Storage': '储藏室',
	'Restroom': '卫生间',
	'Elevator Lobby': '电梯厅',
	'Warehouse': '仓库',
	'Server Room': '机房',
	'Place of Worship': '宗教场所',
	'Private Office': '独立办公室',
	'Open Office': '开放式办公',
	'Lobby': '大堂',
	'Retail Floor': '零售卖场',
	'Waiting Room': '候诊/等候区',
	'Library': '图书馆',
	'Lab': '实验室',
	'Exam Room': '诊室',
	'Hotel Room': '客房',
	'Gym': '健身房',
	'Huddle Room': '小型讨论室',
	'Nurse Station': '护士站',
	'Patient Room': '病房',
	'ICU': '重症监护室',
	'Guest Room': '客房',
	'Parking Garage': '车库',
	'Locker Room': '更衣室',
	'Food Court': '美食广场',
	'Conference Room': '会议室',
	'Boardroom': '董事会会议室',
	'Cafeteria': '食堂',
	'Classroom': '教室',
	'Call Center': '呼叫中心',
	'Auditorium': '礼堂',
	'Event Space': '活动空间',
	'Restaurant': '餐厅',
	'Training Room': '培训室',
	'Banquet Hall': '宴会厅',
	'Living Room': '客厅',
	'Bedroom': '卧室',
	'Kitchen': '厨房',
	'Dining Room': '餐厅',
	'Home Office': '家庭办公',
	'Bathroom': '浴室',
	'Garage': '车库',
	'Basement': '地下室',
	'Laundry': '洗衣房',
	'Patio': '露台',
	'Void / Atrium': '中空 / 中庭',
	'Hall': '走廊',
	'Stair': '楼梯',
	'Raised surfaces': '抬升面',
	'Floor properties': '楼层属性',
	'{count} raised': '已抬升 {count} 处',
	'Surface kind': '抬升面类型',
	Platform: '高台',
	Ramp: '坡道',
	Height: '高度',
	Attenuation: '衰减',
	'Upper height': '上端高度',
	'Lower height': '下端高度',
	'N of steps': '台阶数',
	'Auto ({count} × 0.3 m)': '自动（{count} 级 × 0.3 m）',
	'Solid base floor': '实心底座',
	'Low end': '低端',
	'High end': '高端',
	'Click the opposite corner. Escape cancels.': '点击对角；Esc 取消。',
	'Click one corner of the raised area, then the other.': '先点抬升区域的一角，再点对角。',
	'Draw raised area': '绘制抬升面',
	'Clear raised areas': '清空抬升面',
	'A client on a raised area is measured from its own floor, not the slab. Click an outline to select it; Delete removes it.':
		'抬升面上的终端以其自身高度（而非楼板）计算。单击轮廓可选中，按 Delete 删除。',
	'Store': '储藏',
	'WC': '卫',
	'Elev': '电梯',
	'Whse': '仓库',
	'Server': '机房',
	'Worship': '宗教',
	'Open': '开放',
	'Retail': '零售',
	'Wait': '等候',
	'Exam': '诊室',
	'Hotel': '客房',
	'Huddle': '讨论',
	'Nurse': '护士',
	'Patient': '病房',
	'Guest': '客房',
	'Parking': '车库',
	'Locker': '更衣',
	'Food': '餐饮',
	'Conf': '会议',
	'Board': '董事',
	'Cafe': '食堂',
	'Class': '教室',
	'Calls': '坐席',
	'Audit': '礼堂',
	'Event': '活动',
	'Rest': '餐厅',
	'Train': '培训',
	'Banq': '宴会',
	'Living': '客厅',
	'Bed': '卧室',
	'Dining': '餐厅',
	'Bath': '浴室',
	'Bsmt': '地下',
	'Lndry': '洗衣',
	'Void': '中空',

	'or click the canvas to place access points': '或者在画布上点击放置 AP',
	'or turn on Place APs to add access points': '或者打开「放置 AP」来添加 AP',

	'Restart {index} of {count}': '第 {index}/{count} 次重跑',
	'Pass {pass}/{total} · {floor} ({index}/{count})': '第 {pass}/{total} 轮 · {floor}（{index}/{count}）',
	'Per-floor floor · {floor}': '最弱层补跑 · {floor}',
	'CO-CHANNEL CONFLICTS ({count})': '同信道冲突（{count}）',
	'Scale:': '比例尺：',
	'Walls drawn in full': '墙已画全',
	'Walls partly drawn': '墙画了一部分',
	'Walls barely drawn': '几乎没画墙',
	'How much wall loss the distance model already contains. The tabulated value does include a wall allowance and this app also charges every wall the ray crosses, so the more completely the walls are drawn, the lower the value should be: too high makes coverage radii too small and the plan look like it needs more APs.': '距离损耗模型里已经包含了多少墙体衰减。ITU 表格值本身含墙体补偿，而本程序又按穿越逐墙计费——所以墙画得越全，选得应越低；选高了会让覆盖半径偏小，看起来像需要更多 AP。',
	'Outside the building. Turn on "Allow APs outside rooms" to place an access point here.': '这里在建筑之外。要在此放置 AP，请先打开「允许 AP 位于房间外」。',
	'{count} access point(s) are outside the building: {names}. Re-run the optimiser, move them, or turn on "Allow APs outside rooms".': '有 {count} 个 AP 位于建筑之外：{names}。可以重跑优化器、手动移入，或打开「允许 AP 位于房间外」。',
	'Mounting': '安装高度',
	'Access point placement': 'AP 放置',
	'Click within 1 m of a wall': '在离墙 1 m 以内点击',
	'Click the plan to place': '在图上点击放置',
	'Ceiling mount': '天花板安装',
	'Floor mount': '地面安装',
	'Wall mount': '壁挂安装',
	'Mount height': '离地高度',
	'Project saved': '工程已保存',
	'Project exported as a JSON file': '工程已导出为 JSON 文件',
	'Exported as a PNG file': '已导出 PNG 图片',
	'Exported as a PDF file': '已导出 PDF 文档',
	'A wall-mounted access point has to sit on a wall: click within a metre of one, or pick another mounting.': '壁挂 AP 必须放在墙上：请在离墙 1 m 以内点击，或换一种安装方式。',
	'The project could not be saved: the browser storage is full or unavailable. Export it to a file (File → Export JSON), then remove a floorplan or a floor to make room.': '项目无法保存：浏览器存储已满或不可用。请先用「File → Export JSON」导出到文件，再删掉一张图纸或一层来腾出空间。',
	'This project was saved by a newer version of the app. It has been left untouched — update the app to open it.': '这个项目是被更新版本的应用保存的。它的数据没有被改动 —— 请更新应用后再打开。',
	'Facing': '平面朝向',
	'° in plan': '° 平面',
	'Which way the unit looks in the plan: 0° is +x (right), 90° is +y (down). A wall mount radiates forwards and is attenuated behind, so this is the direction its coverage goes.': '设备在平面里朝哪边：0° 是 +x（右），90° 是 +y（下）。壁挂机向前辐射、背后衰减很大，所以这个方向就是覆盖方向。',
	'Pinned in place': '已固定位置',
	'Pin position': '固定位置',
	'The optimiser leaves this access point exactly where it is. It still counts for coverage, interference and channel planning — it is only its position that is fixed.': '优化器不会移动这个 AP；它照常参与覆盖、干扰与信道规划，只是位置被固定。',
	'Every access point on this floor is pinned in place: there is nothing for the optimiser to move.': '本层所有 AP 都固定了位置：优化器没有可移动的目标。',
	'Pick a model to fill in band, power and range.': '选择型号可自动填入频段、功率与范围。',
	'A label for this access point.': '给这个 AP 起个名字。',
	'2.4 GHz reaches further; 5 and 6 GHz have more channels.': '2.4 GHz 传得更远；5 / 6 GHz 信道更多。',
	'Wider is faster, but more prone to interference.': '信道越宽越快，但更容易受干扰。',
	'Auto lets the solver choose.': '自动：由求解器选择。',
	'Transmit power, in dBm.': '发射功率，单位 dBm。',
	'How high the AP is above this floor.': '这个 AP 离本层地面多高。',
	'Beam: the -3 dB width of the pattern. Aim: where its peak points — positive down, negative up, 0 level.': 'beam：方向图的 −3 dB 宽度。aim：主瓣峰值方向——正朝下、负朝上、0 为水平。',
	'Antenna': '天线',
	'Vertical beamwidth': '垂直波束宽度',
	'Aim': '朝向',
	'° beam': '° 波束',
	'° aim': '° 朝向',
	'A selected access point also has its mount height and its antenna — the beam width and where the beam points — drawn as a bar chart of what they do to the floor.': '选中一个 AP 后还能改它的安装高度和天线（波束宽度与指向），下面那张柱子图就是它们对地面的效果。',
	'Propagation': '传播环境',
	'Propagation environment': '传播环境',
	'Apply the floor to every storey, not just the one you optimise: an all-floors run gives the weakest floor that falls short one more pass with the floor as its own constraint. A1\'s "no floor below X%", which a weighted sum cannot express.': '把下限应用到每一层，而不只是你优化的那一层：整栋优化会给未达标的“最弱层”再加一轮，并以该下限作为它自己的约束。这就是 A1 的“每层都不低于 X%”，加权求和无法表达。',
	'Every floor': '每层都适用',
	'Load a floorplan first': '请先加载平面图',
	'No APs on this floor': '本层没有 AP',
	'No floors with both a floorplan and APs to place': '没有同时具备平面图和 AP 的楼层可优化',
	'Optimization failed': '优化失败',
	'Drag on canvas…': '在画布上拖动…',
	'Drag to align': '拖动以对齐',
	'Floorplan loaded': '已加载平面图',
	'Walls drawn': '已绘制墙体',
	'Detecting…': '识别中…',
	'Detect walls from the floorplan, or import one first': '从平面图识别墙体，或先导入一张平面图',
	'Click the canvas to place access points': '在画布上点击以放置 AP',
	'Turn on Place APs, then click the canvas': '打开「放置 AP」，然后在画布上点击',

	// ── help dialog and panel prose ─────────────────────────────────────
	'Drop a floorplan, place APs, get optimal channels. Multi-floor, with physics-based propagation through walls and floor slabs.': '导入平面图、放置 AP，自动求出最优信道。支持多层，墙体与楼板按物理模型计算衰减。',
	'is a mode, off by default: turn it on (top of the sidebar), click the plan,': '是一个模式，默认关闭：在侧边栏顶部打开它，然后在平面上点击，',
	'to leave.': '退出。',
	'for its material;': '查看它的材质；',
	'for its type and density.': '查看房间类型和密度。',
	'turns the imported plan into a wall mask;': '把导入的平面图转成墙体掩膜；',
	'replaces it and clears every material you painted, so it asks first.': '会替换原有掩膜并清除你涂过的所有材质，所以会先问一次。',
	'in the Floorplan tab. The status bar holds zoom,': '在「平面图」标签页里。状态栏里有缩放、',
	'and the single / tiled / stacked views.': '以及单层／平铺／堆叠视图。',
	'works on the floor on screen;': '只作用于当前屏幕上这一层；',
	'does every storey and moves the building figure;': '会逐层优化并更新整栋楼的数据；',
	'writes the report.': '写出报告。',
	'Behind the gear next to': '点开「放置优化器」旁边的齿轮：',
	'(how much co-channel is traded against coverage; 0 scores coverage alone) ·': '（同信道干扰与覆盖之间的权衡；0 表示只看覆盖）·',
	'(ε-constraint: the result must cover at least this much; 0 = off) ·': '（ε 约束：结果至少要覆盖这么多；0 表示关闭）·',
	'(how many seeds to try, best kept) ·': '（尝试多少组随机起点，保留最好的一组）·',
	'(heatmap floor; below it stays transparent) ·': '（热力图下限；低于此值保持透明）·',
	'and': '和',
	'Only': '本频段只有',
	'non-overlapping channels on this band. Placement and channel assignment are solved one after the other, so on a plan this tight the result may be well short of optimal — try a different Optimize Placement result, or widen the band.': '个不重叠信道。放置和信道分配是先后分别求解的，在这种拥挤的频段上结果可能远达不到最优——可以换一个「优化放置」的结果，或者加宽频段。',
	'{count} floor measured': '已测 {count} 层',
	'{count} floors measured': '已测 {count} 层',
	'{count} below 50%': '{count} 层低于 50%',
	'The building figure is each measured floor’s coverage weighted by that floor’s sample count, so a small storey does not count as much as a large one. Optimising it means optimising the floors in turn and repeating until the building-wide number stops improving — "passes" counts those rounds, and the weakest floor is named rather than folded in, because a mean hides exactly the storey you would want to know about. It is never optimised *for*: a min-max objective is far sharper to search and buys little on average.': '整栋楼的数值是各已测楼层覆盖率按该层采样点数加权的结果，因此小楼层不会和大楼层等权。优化它意味着逐层优化并反复迭代，直到整栋楼的数值不再提升——“轮数”统计的就是这些迭代；最弱的一层会被单独列出而不是并入平均，因为平均值恰好会掩盖你最想知道的那一层。它从不会被直接当作优化目标：min-max 目标搜索起来锐利得多，平均下来收益却很小。',
	'All APs ({count})': '全部 AP（{count}）',
	'Custom (manual settings)': '自定义（手动设置）',
	// ── reports and console ─────────────────────────────────────────────
};

/**
 * Translate an English interface string.
 *
 * Unknown keys come back unchanged, which is the point: a component can be translated before
 * the catalogue is complete without the interface showing key names.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
	let out = i18nState.locale === 'zh' ? (zh[key] ?? key) : key;
	if (vars) {
		for (const [name, value] of Object.entries(vars)) {
			out = out.split(`{${name}}`).join(String(value));
		}
	}
	return out;
}

/** Keys the current locale has no translation for. Used by the catalogue test, not the UI. */
export function untranslatedKeys(keys: readonly string[]): string[] {
	if (i18nState.locale !== 'zh') return [];
	return keys.filter((k) => !(k in zh));
}

export function setLocale(next: Locale): void {
	i18nState.locale = next;
	try {
		localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// Private mode: the choice lasts for the session, which is better than throwing.
	}
	if (typeof document !== 'undefined') {
		document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
	}
}

/** Read the stored choice, if there is one. Called once from the root layout. */
export function restoreLocale(): void {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'zh' || stored === 'en') setLocale(stored);
	} catch {
		// Nothing to restore.
	}
}

export function toggleLocale(): void {
	setLocale(i18nState.locale === 'zh' ? 'en' : 'zh');
}
