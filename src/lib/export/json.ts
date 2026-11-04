/** The project as a JSON file. */
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

/** The underlay as a PNG data URL, so the file is self-contained. */
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

/** The whole project as the text of a `.aetherax.json` file. */
export async function serialize(): Promise<string> {
	const doc = toDocument({ floorCoverage });
	/*
	 * The document lists the floors in `floorState.floors` order, so the index is the
	 * floor. Asking the floor itself for its underlay also keeps a floor that is missing
	 * from the state from being given another floor's image.
	 */
	for (const [index, floor] of doc.floors.entries()) {
		const image = await floorplanToDataUrl(floorState.floors[index]?.floorplanUrl ?? null);
		if (image) floor.floorplanImage = image;
	}
	return JSON.stringify(doc, null, '\t');
}

/**
 * Replace the project with the one in a file.
 *
 * Throws rather than half-loading: the caller (`importJson` → the toolbar) shows the
 * message, and a file that cannot be understood must not leave the editor holding a
 * mixture of two projects.
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
	// Newer than this build: say which, rather than "invalid". The file on disk is the user's
	// and is not touched — only storage deletion has that power, and it is guarded too.
	if (isFromNewerVersion(parsed)) {
		throw new Error(
			`This project was saved by a newer version of the app (file version ${String(version)}, this build reads ${DOCUMENT_VERSION}).`
		);
	}

	const doc = migrate(parsed);
	if (!doc) throw new Error('Invalid project file: no floors');

	// A file had no name of its own; the app called it something rather than leaving the
	// previous project's name on it. (Storage restores keep `Untitled Project` instead.)
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
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${projectMeta.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.aetherax.json`;
	a.click();
	URL.revokeObjectURL(url);
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
