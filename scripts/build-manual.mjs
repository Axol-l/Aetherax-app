/**
 * Render the Chinese manual into a standalone help page.
 *
 * The manual is maintained as Markdown in docs/MANUAL.zh-CN.md. This turns the small subset
 * used there — headings, ordered lists, pipe tables and paragraphs — into one self-contained
 * HTML file under `static/`, so the Help button can open a real page without a Markdown
 * runtime in the app and without a second copy of the text to keep in step.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'docs', 'MANUAL.zh-CN.md');
const target = join(root, 'static', 'manual.html');

const escapeHtml = (text) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

/** Pipe table rows → cells. The separator row is dropped by the caller. */
function cells(line) {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((cell) => cell.trim());
}

function render(markdown) {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const out = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (!line.trim()) {
			i++;
			continue;
		}

		const heading = /^(#{1,3})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			out.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
			i++;
			continue;
		}

		if (line.trimStart().startsWith('|')) {
			const rows = [];
			while (i < lines.length && lines[i].trimStart().startsWith('|')) {
				rows.push(lines[i]);
				i++;
			}
			const body = rows.filter((row) => !/^\|[\s:|-]+\|?$/.test(row.trim()));
			if (body.length > 0) {
				const [head, ...rest] = body;
				out.push('<table>');
				out.push('<thead><tr>');
				for (const cell of cells(head)) out.push(`<th>${escapeHtml(cell)}</th>`);
				out.push('</tr></thead><tbody>');
				for (const row of rest) {
					out.push('<tr>');
					for (const cell of cells(row)) out.push(`<td>${escapeHtml(cell)}</td>`);
					out.push('</tr>');
				}
				out.push('</tbody></table>');
			}
			continue;
		}

		if (/^\d+\.\s/.test(line)) {
			out.push('<ol>');
			while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
				const item = lines[i].replace(/^\d+\.\s+/, '');
				out.push(`<li>${escapeHtml(item)}</li>`);
				i++;
			}
			out.push('</ol>');
			continue;
		}

		const paragraph = [];
		while (i < lines.length) {
			const next = lines[i];
			if (
				!next.trim() ||
				/^#{1,3}\s/.test(next) ||
				/^\d+\.\s/.test(next) ||
				next.trimStart().startsWith('|')
			) {
				break;
			}
			paragraph.push(next.trim());
			i++;
		}
		out.push(`<p>${escapeHtml(paragraph.join(' '))}</p>`);
	}

	return out.join('\n');
}

const manual = readFileSync(source, 'utf8');
const body = render(manual);
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aetherax 使用手册</title>
<style>
	:root { color-scheme: light; }
	* { box-sizing: border-box; }
	body {
		margin: 0 auto;
		padding: 32px 28px 64px;
		max-width: 920px;
		background: #ffffff;
		color: #1f2937;
		font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
		font-size: 15px;
		line-height: 1.8;
	}
	h1 { font-size: 26px; margin: 0 0 20px; color: #111827; }
	h2 { font-size: 20px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; color: #111827; }
	h3 { font-size: 16px; margin: 24px 0 8px; color: #111827; }
	p { margin: 8px 0; }
	ol { margin: 8px 0 12px; padding-left: 24px; }
	li { margin: 4px 0; }
	table { border-collapse: collapse; width: 100%; margin: 12px 0 18px; font-size: 14px; }
	th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; vertical-align: top; }
	th { background: #f3f4f6; font-weight: 600; }
	tr:nth-child(even) td { background: #fafafa; }
</style>
</head>
<body>
${body}
</body>
</html>
`;

writeFileSync(target, html, 'utf8');
console.log(`manual: ${manual.length} chars → ${target}`);
