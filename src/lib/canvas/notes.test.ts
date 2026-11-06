/**
 * 标注：判断指针所指内容的命中检测，以及标注点所示文本的换行。
 * 这两项只需数值、无需画布，因此单独测试；容差参数使用世界单位，
 * 调用方将屏幕容差除以缩放比例，使标注点在屏幕上大小恒定。
 */
import { describe, expect, it } from 'vitest';
import { noteAtPoint, wrapText, type Note } from './renderers/notes.js';

const notes: Note[] = [
	{ id: 'a', x: 10, y: 10, text: 'Steel door in the lobby' },
	{ id: 'b', x: 50, y: 10, text: 'Keep clear' }
];

describe('noteAtPoint', () => {
	it('finds the pin under the point', () => {
		expect(noteAtPoint(notes, { x: 11, y: 11 }, 3)?.id).toBe('a');
		expect(noteAtPoint(notes, { x: 50, y: 10 }, 3)?.id).toBe('b');
	});

	it('returns nothing away from every pin', () => {
		expect(noteAtPoint(notes, { x: 30, y: 40 }, 3)).toBeNull();
	});

	it('picks the nearest when two are in range', () => {
		const close: Note[] = [
			{ id: 'far', x: 10, y: 10, text: '' },
			{ id: 'near', x: 11, y: 10, text: '' }
		];
		expect(noteAtPoint(close, { x: 11, y: 10 }, 5)?.id).toBe('near');
	});

	it('a tolerance of zero only catches an exact hit', () => {
		expect(noteAtPoint(notes, { x: 10, y: 10 }, 0)?.id).toBe('a');
		expect(noteAtPoint(notes, { x: 10.5, y: 10 }, 0)).toBeNull();
	});
});

describe('wrapText', () => {
	it('keeps a short note on one line', () => {
		expect(wrapText('Steel door', 42, 2)).toEqual(['Steel door']);
	});

	it('breaks a long note at word boundaries', () => {
		const lines = wrapText(
			'The lift lobby has a steel door so the signal will not get through here',
			20,
			2
		);
		expect(lines.length).toBeLessThanOrEqual(2);
		expect(lines[0]!.length).toBeLessThanOrEqual(20);
	});

	it('marks a truncated note with an ellipsis', () => {
		const lines = wrapText('one two three four five six seven eight nine ten', 6, 2);
		expect(lines.length).toBe(2);
		expect(lines.join(' ')).toContain('…');
	});

	it('never returns an empty bubble', () => {
		expect(wrapText('', 42, 2)).toEqual(['…']);
		expect(wrapText('   ', 42, 2)).toEqual(['…']);
	});
});
