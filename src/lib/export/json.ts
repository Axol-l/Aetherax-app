/** 把工程导出成 JSON 文件，以及从文件读回来。 */
import { appState } from '$state/app.svelte.js';
import { clearSelection } from '$state/canvas.svelte.js';
import { floorState } from '$state/floor-state.svelte.js';
import { floorCoverage } from '$state/optimizer.svelte.js';
import { projectMeta } from '$state/project-meta.svelte.js';
import {
	applyDocument,
	DOCUMENT_VERSION,
	isFromNewerVersion,
	migrate,
	toDocument
} from '$state/project-document.js';

/** 把底图转成 PNG data URL，让文件自带图片。 */
async function floorplanToDataUrl(url: string | null): Promise<string | undefined> {
	if (!url) return undefined;
	if (url.startsWith('data:')) return url;

	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = reject;
			img.src = url;
		});
		const canvas = document.createElement('canvas');
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, 0, 0);
		return canvas.toDataURL('image/png');
	} catch {
		return undefined;
	}
}

/** 把整个工程序列化成 `.aetherax.json` 的文本。 */
export async function serialize(): Promise<string> {
	const doc = toDocument({ floorCoverage });
	/*
	 * 楼层顺序与 `floorState.floors` 一致，按序号取对应底图。
	 */
	for (const [index, floor] of doc.floors.entries()) {
		const image = await floorplanToDataUrl(floorState.floors[index]?.floorplanUrl ?? null);
		if (image) floor.floorplanImage = image;
	}
	return JSON.stringify(doc, null, '\t');
}

/**
 * 用文件内容替换当前工程。
 * 解析失败直接抛错，不做半加载，避免编辑器里残留两个工程的混合状态。
 */
export function deserialize(json: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error('Invalid JSON file');
	}

	const version = (parsed as { version?: unknown } | null)?.version;
	if (typeof version !== 'number' || version < 2) {
		throw new Error('Unsupported file version');
	}
	// 版本比本程序新时说明具体版本号
	if (isFromNewerVersion(parsed)) {
		throw new Error(
			`This project was saved by a newer version of the app (file version ${String(version)}, this build reads ${DOCUMENT_VERSION}).`
		);
	}

	const doc = migrate(parsed);
	if (!doc) throw new Error('Invalid project file: no floors');

	// 文件里没有名字就用默认名
	const name = (parsed as { name?: unknown }).name;
	if (typeof name === 'string' && name.length > 0) doc.name = name;
	else doc.name = 'Imported Project';

	applyDocument(doc, { floorCoverage });
	clearSelection();

	if (doc.aps.length > 0) {
		appState.sidebarPanel = 'aps';
		appState.sidebarOpen = true;
	} else if (doc.floors[0]?.floorplanImage) {
		appState.sidebarPanel = 'floorplan';
	}
}

export async function downloadJson(): Promise<void> {
	const json = await serialize();
	downloadTextFile(json);
}

function downloadTextFile(json: string): void {
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${projectMeta.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.aetherax.json`;
	a.click();
	URL.revokeObjectURL(url);
}

/**
 * Save the project to a file the user chooses.
 *
 * Chromium's File System Access API gives a native Save dialog; the Tauri webview
 * supports it on current Windows builds. If it is unavailable, fall back to a
 * regular download so the file still leaves the application.
 *
 * Returns whether the file actually left the app. Cancelling the dialog is not an
 * export, so it reports false — the caller announces success only on true.
 */
export async function saveProjectFile(): Promise<boolean> {
	const json = await serialize();
	const picker = (
		window as Window & {
			showSaveFilePicker?: (options: {
				suggestedName: string;
				types: Array<{ description: string; accept: Record<string, string[]> }>;
			}) => Promise<{
				createWritable: () => Promise<{
					write: (data: string) => Promise<void>;
					close: () => Promise<void>;
				}>;
			}>;
		}
	).showSaveFilePicker;
	if (!picker) {
		downloadTextFile(json);
		return true;
	}
	try {
		const handle = await picker({
			suggestedName: `${projectMeta.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.aetherax.json`,
			types: [
				{
					description: 'Aetherax project',
					accept: { 'application/json': ['.aetherax.json', '.json'] }
				}
			]
		});
		const writable = await handle.createWritable();
		await writable.write(json);
		await writable.close();
		return true;
	} catch (error) {
		// AbortError means the user cancelled the dialog; do not download behind their back,
		// and do not claim an export either.
		if ((error as { name?: string }).name === 'AbortError') return false;
		downloadTextFile(json);
		return true;
	}
}

export function importJson(file: File): Promise<void> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				deserialize(reader.result as string);
				resolve();
			} catch (err) {
				reject(err);
			}
		};
		reader.onerror = () => reject(new Error('Failed to read file'));
		reader.readAsText(file);
	});
}
