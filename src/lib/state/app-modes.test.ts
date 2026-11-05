import { describe, expect, it, beforeEach } from 'vitest';
import { appState, setTool } from './app.svelte.js';

/*
 * 同一时间只能有一个工具开着。
 *
 * 以前七种模式是七个布尔值，每个 setter 自己清掉它前面的那些；其中两个（画墙工具和标注模式）
 * 是切换它们的组件直接写进 state 的，压根没走这套逻辑，于是能和规划区域同时开着。
 * 这些测试盯的是取代它的那条性质：不管从哪个入口开，开着的永远只有一个。
 */

describe('the editing tool', () => {
	beforeEach(() => {
		setTool('none');
		appState.showFloorBelow = false;
	});

	it('arms one tool and disarms the one before it', () => {
		appState.wallVectorMode = true;
		expect(appState.tool).toBe('wall');

		// 以前真能出现的情况：画墙工具和标注模式同时开着，
		// 因为两者都不走会清掉对方的 setter。
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

		// 每条退出路径都会调自己的「关掉」，哪怕它从来没被打开过。
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
