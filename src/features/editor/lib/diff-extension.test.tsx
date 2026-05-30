import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { computeDiffData } from '@shared/review-diff';

import { CodeEditor } from '../components/code-editor';

import type { DiffData } from './diff-decorations';

function renderDiff(before: string, after: string, hunkStatuses?: Array<'pending' | 'approved' | 'rejected'>): HTMLElement {
	const diffData: DiffData | undefined = computeDiffData(before, after);
	if (!diffData) {
		throw new Error('Expected a diff for the provided content');
	}

	const { container } = render(
		<CodeEditor value={after} filename="/src/main.ts" readonly diffData={diffData} hunkStatuses={hunkStatuses} />,
	);
	return container;
}

describe('diff-extension', () => {
	it('renders added-line decorations for added hunks', () => {
		const before = 'line1\nline2\nline3\n';
		const after = 'line1\nadded-a\nadded-b\nline2\nline3\n';

		const container = renderDiff(before, after);

		expect(container.querySelectorAll('.cm-diff-added')).toHaveLength(2);
	});

	it('renders one removed-line widget per removed line', () => {
		const before = 'line1\nremove-a\nremove-b\nline2\n';
		const after = 'line1\nline2\n';

		const container = renderDiff(before, after);

		const removed = container.querySelectorAll('.cm-diff-removed-line');
		expect(removed).toHaveLength(2);
		expect([...removed].map((node) => node.textContent)).toEqual(['remove-a', 'remove-b']);
	});

	it('hides decorations for resolved (non-pending) change groups', () => {
		const before = 'line1\nline2\nline3\n';
		const after = 'line1\nadded-a\nline2\nline3\n';

		// Single added change group marked approved -> its decorations are hidden.
		const container = renderDiff(before, after, ['approved']);

		expect(container.querySelectorAll('.cm-diff-added')).toHaveLength(0);
	});

	it('keeps pending groups visible when another group is resolved', () => {
		const before = 'a\nb\nc\nd\ne\nf\n';
		const after = 'a\nadded-1\nb\nc\nd\ne\nadded-2\nf\n';

		// Two separate added groups; resolve only the first.
		const container = renderDiff(before, after, ['approved']);

		expect(container.querySelectorAll('.cm-diff-added')).toHaveLength(1);
	});
});
