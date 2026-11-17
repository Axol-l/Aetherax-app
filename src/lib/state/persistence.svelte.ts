/**
 * 工程持久化：把工程存进浏览器存储，以及启动时读回来
 */
import { debug } from '$lib/log.js';
import { floorCoverage as floorCoverageState } from './optimizer.svelte.js';
import { floorState, onFloorRemoved } from './floor-state.svelte.js';
import { appState } from './app.svelte.js';
import { t } from './i18n.svelte.js';
import { applyDocument, isFromNewerVersion, migrate, toDocument } from './project-document.js';
import {
	indexDbStore,
	localStore,
	migrateInto,
	type KeyValueStore,
	type StorageBackend
} from './storage.js';

/**
 * 本应用写入的每个键都以这个开头。
 *
 * 导出来是因为 `WelcomeDialog` 在应用恢复数据之前也要查同一个前缀。
 */
export const STORAGE_PREFIX = 'aetherax:';
/** 应用改名之前用的前缀。只读，永远不写。 */
const LEGACY_PREFIX = 'deconflict:';

const STORAGE_KEY = `${STORAGE_PREFIX}project`;
const FLOORPLAN_KEY = `${STORAGE_PREFIX}floorplan`;
/**
 * 最后一次编辑之后，隔多久跑一次自动保存。
 *
 * 5 秒：一次拖动、一串墙体编辑都会在这个窗口内做完，最后只写一次盘。
 * 每次保存都要序列化所有楼层的遮罩图（好几 MB），所以不能更短。
 */
const SAVE_DELAY = 5000;

/**
 * 某个楼层底板图（underlay）存在哪个键下。
 *
 * 只留一个函数：以前写入、恢复、清除三处各拼一遍字符串，
 * 而启动时的数据迁移按名字扫，正好漏掉「每层一个键」这种形式，结果切后端时底板图全留在原地。
 */
const floorplanKey = (floorId: string) => `${FLOORPLAN_KEY}:${floorId}`;

/**
 * 每个楼层已经编码并写过的底板图 URL，按楼层 id 记。
 */
const encodedUnderlays = new Map<string, string>();

/**
 * 是否还有改动没写到存储里。
 *
 * 和 `saveTimeout` 不是一回事：定时器可能只是「上好了弦」，它排在后面的那次写入可以还在路上。
 * 关页面前只要两者之一为真，就值得补写一次。
 */
let savePending = false;

/**
 * 把旧前缀下的所有键复制到新前缀，只做一次。
 *
 * 按前缀扫而不是列固定键：底板图是 `<prefix>floorplan:<floorId>`，楼层 id 只有运行时才有。
 * 不删旧键，回滚到上个版本还能找到工程；新前缀下已经有的键也不覆盖。
 *
 * 重复调用安全，在任何东西之前调用也安全：只复制；localStorage 打不开也不影响应用运行，只是记不住东西。
 */
export function migrateLegacyStorageKeys(): void {
	try {
		const moves: Array<[string, string]> = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key && key.startsWith(LEGACY_PREFIX)) {
				moves.push([key, STORAGE_PREFIX + key.slice(LEGACY_PREFIX.length)]);
			}
		}
		for (const [oldKey, newKey] of moves) {
			if (localStorage.getItem(newKey) !== null) continue;
			const value = localStorage.getItem(oldKey);
			if (value !== null) localStorage.setItem(newKey, value);
		}
	} catch {
		// 隐私模式或配额满了：应用照常跑，只是从空白开始。
	}
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
export const persistenceState = $state({ lastSaved: null as Date | null });

/**
 * 把工程写进当前使用的存储。
 *
 * 后端本身是异步的（IndexedDB，没有就退回 localStorage，见 `state/storage.ts`），所以这里也异步。
 * 防抖那头的调用方发完就不管，但失败不会静默：会落到 `appState.storageNotice`。
 *
 * 文档本身由 `project-document.ts` 组装，文件导入导出走的也是它；这个函数只管写到哪、写不了怎么提示。
 */
async function saveToStorage(): Promise<void> {
	/*
	 * 定时器已经触发，说明没有待处理的东西了。
	 *
	 * 以前不清这个句柄，之后每次 `scheduleSave(true)` 都提前返回：
	 * 用 `keep` 的调用方以为保存马上就来，结果再也没排过保存，
	 * 一个 AP 的挂载写入只落盘一次，之后再也不写。
	 */
	if (saveTimeout) clearTimeout(saveTimeout);
	saveTimeout = null;

	const store = await ensureStore();
	try {
		const started = performance.now();
		const json = JSON.stringify(toDocument({ floorCoverage: floorCoverageState }));
		// 计时并打日志：写入要是花了几秒，就是卡在用户干活中间，不打印就发现不了。
		debug(
			`[save] ${json.length} bytes serialised in ${Math.round(performance.now() - started)} ms`
		);
		await store.write(STORAGE_KEY, json);

		/*
		 * 底板图是这次保存的一部分，不是随手一写的附属品。
		 *
		 * 以前它写在 `img.onload` 里，失败被空的 `.catch` 吞掉，而 `lastSaved` 和提示
		 * 早就按文档设好了——于是可能提示「已保存」，下次打开却少了某层的图。
		 * 现在底板图写失败，整次保存就算失败，也照样进 `storageNotice`。
		 */
		await writeUnderlays(store);

		debug(`[save] written in ${Math.round(performance.now() - started)} ms`);
		persistenceState.lastSaved = new Date();
		savePending = false;
		// 后面有一次保存成功了，就把警告清掉：之前是存储满了，现在已经不是。
		appState.storageNotice = null;
	} catch {
		appState.storageNotice = t(
			'The project could not be saved: the browser storage is full or unavailable. Export it to a file (File → Export JSON), then remove a floorplan or a floor to make room.'
		);
	}
}

/**
 * 把还没落盘的底板图都写进去。
 *
 * 图片进来时是 `blob:` URL，要存必须转成 data URL。只看还拿着 blob 的楼层，
 * 而且每张图只编码一次（见 `encodedUnderlays`）。
 */
async function writeUnderlays(store: KeyValueStore): Promise<void> {
	const writes: Array<Promise<void>> = [];
	for (const floor of floorState.floors) {
		const url = floor.floorplanUrl;
		if (!url || !url.startsWith('blob:')) continue;
		if (encodedUnderlays.get(floor.id) === url) continue;
		writes.push(
			encodeUnderlay(url).then(async (dataUrl) => {
				await store.write(floorplanKey(floor.id), dataUrl);
				encodedUnderlays.set(floor.id, url);
			})
		);
	}
	await Promise.all(writes);
}

/** 把底板图的 URL 转成 data URL，好存起来。 */
function encodeUnderlay(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onerror = () => reject(new Error('the floorplan image could not be decoded'));
		image.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				reject(new Error('the floorplan image could not be encoded'));
				return;
			}
			ctx.drawImage(image, 0, 0);
			resolve(canvas.toDataURL('image/png'));
		};
		image.src = url;
	});
}

/**
 * 工程存在哪个后端。
 *
 * 目前故意还是 `localstorage`；留这个开关，是为了以后换成另一个只改一行，不用重写。
 * 之所以还没换：所有测试辅助函数都读 `localStorage` 判断「应用存了什么」，用户自己的工具可能也是。
 * 所以搬去 IndexedDB 得把这些读取方一起搬，那是另一件事，得量过再说。
 * `indexeddb` 的实现和单测都在这个开关后面；它为什么是目标，见 `state/storage.ts`
 *（5 MB 配额 vs 每层一张 PNG 遮罩）。
 */
const BACKEND: StorageBackend = 'localstorage';

/**
 * 当前用的存储，只打开一次。
 *
 * 不管最后选哪个后端，只存在于 localStorage 里的记录都会先搬过来，
 * 这样旧版本存的工程在这个版本里也能找到。
 */
let projectStore: KeyValueStore | null = null;
async function ensureStore(): Promise<KeyValueStore> {
	if (projectStore) return projectStore;
	let store: KeyValueStore = localStore;
	if (BACKEND === 'indexeddb') {
		try {
			// 真做一次读写，而不是只测特性：隐私窗口会暴露 `indexedDB`，却拒绝打开库。
			await indexDbStore.keys();
			store = indexDbStore;
		} catch {
			store = localStore;
		}
	}
	try {
		await migrateInto(store, await legacyRecordKeys(store));
	} catch {
		// 旧数据还在也还能读：就用手上有的继续，总比启动后什么工程都没有强。
	}
	projectStore = store;
	return store;
}

/**
 * 旧版本留在 `localStorage` 里、这个存储应该搬过来的所有记录。
 *
 * 按前缀枚举而不是写死，因为底板图的键是 `floorplan:<floorId>`，id 只有运行时才有。
 * 以前只写死两个固定键，结果切后端时工程文档过去了，每层的图却全丢了。
 */
async function legacyRecordKeys(store: KeyValueStore): Promise<string[]> {
	// 这个存储本来就把所有东西都装着，没什么可搬的。
	if (store.backend === 'localstorage') return [];
	const keys = await localStore.keys();
	return keys.filter(
		(key) => key === STORAGE_KEY || key === FLOORPLAN_KEY || key.startsWith(`${FLOORPLAN_KEY}:`)
	);
}

/** 工程在哪个后端，给存储提示用。导出是为了诊断。 */
export function storageBackend(): StorageBackend | null {
	return projectStore?.backend ?? null;
}

export async function restoreFromStorage(): Promise<boolean> {
	// 第一步：改名之前存的工程还在旧前缀下。这是 localStorage 的事，要在读任何东西之前做。
	migrateLegacyStorageKeys();
	const store = await ensureStore();
	try {
		const raw = await store.read(STORAGE_KEY);
		if (!raw) return false;

		/*
		 * 新版本写的文档要留着，不删。
		 *
		 * `migrate` 读不懂它（不认识那些字段），重写会丢字段；删掉就等于把
		 * 「这个版本打不开」变成「工程没了」。所以原样留在那里，只提示为什么没加载。
		 */
		const parsed: unknown = JSON.parse(raw);
		if (isFromNewerVersion(parsed)) {
			appState.storageNotice = t(
				'This project was saved by a newer version of the app. It has been left untouched — update the app to open it.'
			);
			return false;
		}

		const doc = migrate(parsed);
		if (!doc) {
			await store.remove(STORAGE_KEY);
			await store.remove(FLOORPLAN_KEY);
			return false;
		}

		/*
		 * 底板图各占一个键、每层一个，在应用文档之前先读回文档里，
		 * 这样图是跟着楼层一起到位的，不用事后打补丁。
		 * 旧版那个单键是 v2 格式的，留给仅存的那个还用它的工程。
		 */
		for (const floor of doc.floors) {
			const perFloor = await store.read(floorplanKey(floor.id));
			if (perFloor) floor.floorplanImage = perFloor;
		}
		if (!doc.floors[0]!.floorplanImage) {
			const legacyFloorplan = await store.read(FLOORPLAN_KEY);
			if (legacyFloorplan) doc.floors[0]!.floorplanImage = legacyFloorplan;
		}

		// 撤销历史由 `applyDocument` 清掉，所有加载都会走那道门——见那里的说明。
		applyDocument(doc, { floorCoverage: floorCoverageState });
		return true;
	} catch {
		return false;
	}
}

/**
 * 忘掉本应用存过的所有东西：工程和每层的底板图。
 *
 * 按前缀枚举而不是查应用自己的键表，因为有些键在楼层没了之后就成了没人管的孤儿：
 * 楼层已从 `floorState.floors` 移除，它的图还占着几 MB 配额，而再没有代码会去删它。
 */
export async function clearSavedState(): Promise<void> {
	const store = await ensureStore();
	for (const key of await store.keys()) {
		if (key === STORAGE_KEY || key === FLOORPLAN_KEY || key.startsWith(`${FLOORPLAN_KEY}:`)) {
			await store.remove(key);
		}
	}
	encodedUnderlays.clear();
	persistenceState.lastSaved = null;
}

/**
 * 删掉某个楼层存的底板图，因为那个楼层没了。
 *
 * 和 `clearSavedState` 分开：删楼层不等于删工程，而且调用方才知道这两件事（见 `FloorStrip`）。
 * 把删除留在这里，键的拼法就不用再写第四遍。
 */
export async function forgetFloorplan(floorId: string): Promise<void> {
	encodedUnderlays.delete(floorId);
	const store = await ensureStore();
	try {
		await store.remove(floorplanKey(floorId));
	} catch {
		// 存储删不掉记录，不该成为拒绝删楼层的理由——内存里的删除已经发生了。
	}
}
/*
 * 楼层没了，它的底板图跟着删。
 *
 * 用注册回调而不是让 UI 来调：存储键是这个模块自己的事，靠调用方记得，迟早会忘。
 * `floor-state` 不能反过来 import 这里（这里读它），所以它回调过来。
 */
onFloorRemoved((floorId) => void forgetFloorplan(floorId));

/**
 * 用户让存就马上存，而且要说一声。
 *
 * 防抖的 `scheduleSave` 适合编辑，不适合点菜单或按快捷键：用户在等回应，
 * 两秒后才静默存完，看起来就像按钮没反应。这里立刻写、取消待触发的定时器（免得写两次），
 * 然后短暂显示一下「已保存」。
 */
export async function saveNow(): Promise<void> {
	savePending = true;
	if (saveTimeout) {
		clearTimeout(saveTimeout);
		saveTimeout = null;
	}
	await saveToStorage();
	appState.savedNotice = t('Project saved');
	if (savedNoticeTimer) clearTimeout(savedNoticeTimer);
	savedNoticeTimer = setTimeout(() => {
		appState.savedNotice = null;
		savedNoticeTimer = null;
	}, 2500);
}

let savedNoticeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 防抖之后保存，替换掉已经排着的那次。
 *
 * `keep` 给「改动来自后台工作」的调用方：改动还是要落盘，但不能把用户自己编辑排好的保存往后推。
 * 自动求解和对比结果的上色都需要它——以前它们改了 state 却从不保存，
 * 落盘的是优化器两秒前按旧位置算出来的东西。
 */
export function scheduleSave(keep = false): void {
	savePending = true;
	if (keep && saveTimeout) return;
	if (saveTimeout) clearTimeout(saveTimeout);
	// `saveToStorage` 自己打开存储、自己报错；防抖只负责决定「什么时候」。
	saveTimeout = setTimeout(() => {
		saveTimeout = null;
		/*
		 * 放在空闲帧里跑，不在定时器那一帧跑。
		 *
		 * 一次写入要序列化每层的遮罩（好几 MB base64），而定时器正好在最后一次编辑后几秒触发，
		 * 那会儿手可能还在鼠标上。空闲回调把这次写入挪到两个手势之间；
		 * timeout 是兜底，保证帧一直不空闲也还是会写。
		 */
		const run = () => void saveToStorage();
		if (typeof requestIdleCallback === 'function') {
			requestIdleCallback(run, { timeout: 1500 });
		} else {
			run();
		}
	}, SAVE_DELAY);
}

export async function hasSavedState(): Promise<boolean> {
	const store = await ensureStore();
	return (await store.read(STORAGE_KEY)) !== null;
}

/**
 * 同步写一次工程，给窗口即将关闭那一刻用。
 *
 * 自动保存是 5 秒防抖 + 异步写入，这对编辑合适，对正在销毁的窗口不合适：
 * 在防抖窗口内关掉会丢最后一次编辑，而且没东西能补救——promise 链活不过它所属的页面。
 *
 * 所以这是唯一还来得及的写法：不 await、不等空闲帧。它只写文档（底板图要用 `<img>`
 * 解码再编码，没法同步），因此只是安全网，不是正常保存的替代品；也正因为如此，它不动待触发的定时器和 `savePending`。
 *
 * 返回有没有写成功。`false` 表示没有待写内容，或者当前后端不支持同步写（IndexedDB 就不支持，见 `KeyValueStore.writeSync`）。
 */
export function flushSaveSync(): boolean {
	if (!savePending) return false;
	// `projectStore` 就是 `ensureStore` 定下来的那个。首次打开前只有 localstorage 存在，
	// 用它是对的——因为当前后端就是它，不是猜它以后会变成谁。
	const store = projectStore ?? (BACKEND === 'localstorage' ? localStore : null);
	if (!store?.writeSync) return false;
	try {
		store.writeSync(
			STORAGE_KEY,
			JSON.stringify(toDocument({ floorCoverage: floorCoverageState }))
		);
		return true;
	} catch {
		// 配额满了或存储没了：交给异步那条路径去好好报错。
		return false;
	}
}

let unloadFlushInstalled = false;

/**
 * 页面离开前再存一次。
 *
 * 三个入口，因为单独一个覆盖不了所有关闭方式：
 *
 * - `flush-before-close`：桌面外壳发的事件。它拦下关窗、先问页面一声，随后照样销毁（`src-tauri/src/lib.rs`）。
 *   只有这个是「保证」在关闭前跑到，因为被销毁的 webview 不一定还会发 `pagehide`。
 * - `pagehide`：浏览器自己的最后一声，`pnpm dev` 和别的宿主靠它。
 * - `visibilitychange` → hidden：早一步的同一件事，也是手机锁屏或合盖时唯一会发的。
 *
 * 幂等；不在浏览器里（构建时预渲染）什么都不做。
 */
export function installUnloadFlush(): void {
	if (unloadFlushInstalled) return;
	if (typeof window === 'undefined' || typeof document === 'undefined') return;
	unloadFlushInstalled = true;

	const flush = (): void => {
		if (!flushSaveSync()) return;
		/*
		 * 同步那次只写了文档。底板图还得走异步路径；
		 * 页面活下来（切标签、用户取消了关闭）时，不能留着一张永远没进存储的图。
		 */
		void saveToStorage();
	};

	addEventListener('pagehide', flush);
	addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flush();
	});
	void listenForCloseRequest(flush);
}

/**
 * 外壳的「即将关闭」事件，只有跑在外壳里时才有。
 *
 * 懒加载且容错：浏览器版本没有 `__TAURI_INTERNALS__`，旧外壳也没有这个事件可听。
 * 这两种情况都只是退回 `pagehide`，不是失败。
 */
async function listenForCloseRequest(flush: () => void): Promise<void> {
	const host = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
	if (!host) return;
	try {
		const { listen } = await import('@tauri-apps/api/event');
		await listen('flush-before-close', () => flush());
	} catch {
		// 没有事件 API：窗口照样会关，`pagehide` 是兜底。
	}
}
