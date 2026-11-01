import { describe, expect, it, beforeEach } from 'vitest';
import { appState, setTool } from './app.svelte.js';

/*
 * One tool at a time.
 *
 * The seven modes used to be seven booleans, each setter clearing the ones written before
 * it, and two of them (the wall tool and note mode) were written straight into the state by
 * the components that toggled them — so they were never in that scheme and could be armed
 * on top of the planning area. These tests pin the property that replaced it: whatever is
 * armed is the only thing armed, whichever door it came through.
 */

describe('the editing tool', () => {
	beforeEach(() => {
		setTool('none');
		appState.showFloorBelow = false;
	});

	it('arms one tool and disarms the one before it', () => {
		appState.wallVectorMode = true;
		expect(appState.tool).toBe('wall');

		// The case that used to be possible: the drawing tool and note mode both armed,
		// because neither of them went through a setter that cleared the other.
		appState.noteMode = true;
		expect(appState.wallVectorMode).toBe(false);
		expect(appState.noteMode).toBe(true);
		expect(appState.tool).toBe('note');
	});

	it('keeps the planning area exclusive with everything', () => {
		appState.planningDrawMode = true;
		appState.wallVectorMode = true;

		expect(appState.planningDrawMode).toBe(false);
		expect(appState.wallTool).toBe('line');
		expect(appState.tool).toBe('wall');
	});

	it('treats a tool that is not armed as a no-op when it is turned off', () => {
		appState.wallVectorMode = true;

		// Every exit path calls its own "off", including paths that never turned it on.
		appState.noteMode = false;
		appState.calibrateMode = false;
		appState.surfaceMode = false;

		expect(appState.wallVectorMode).toBe(true);
		expect(appState.tool).toBe('wall');
	});

	it('reports every mode as a view of the one field', () => {
		for (const [kind, read] of [
			['wall', () => appState.wallVectorMode],
			['note', () => appState.noteMode],
			['align', () => appState.floorAlignMode],
			['calibrate', () => appState.calibrateMode],
			['planning', () => appState.planningDrawMode],
			['surface', () => appState.surfaceMode],
			['place-ap', () => appState.apPlaceMode]
		] as const) {
			setTool(kind);
			expect(read(), `${kind} should read as armed`).toBe(true);
			expect(appState.tool).toBe(kind);
			setTool('none');
			expect(read(), `${kind} should read as armed off`).toBe(false);
		}
	});

	it('owns the ghost of the floor below while aligning', () => {
		setTool('align');
		expect(appState.showFloorBelow).toBe(true);

		setTool('none');
		expect(appState.showFloorBelow).toBe(false);
	});

	it('leaves a ghost the user turned on themselves alone', () => {
		appState.showFloorBelow = true;

		setTool('align');
		setTool('none');

		expect(appState.showFloorBelow).toBe(true);
	});

	it('drops the draft of the tool it is leaving', () => {
		setTool('planning');
		appState.planningDraft = [{ x: 1, y: 2 }];
		setTool('surface');
		expect(appState.planningDraft).toEqual([]);

		appState.surfaceDraft = { ax: 0, ay: 0, bx: 1, by: 1 };
		setTool('calibrate');
		expect(appState.surfaceDraft).toBeNull();

		appState.calibrationPoints = [{ x: 3, y: 4 }];
		setTool('none');
		expect(appState.calibrationPoints).toEqual([]);
	});
});
