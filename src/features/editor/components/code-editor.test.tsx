import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodeEditor } from './code-editor';

describe('CodeEditor', () => {
	it('does not emit onChange when external value updates replace the document', () => {
		const handleChange = vi.fn();
		const { rerender } = render(<CodeEditor value="const before = true;" filename="/src/main.ts" onChange={handleChange} />);

		rerender(<CodeEditor value="const after = true;" filename="/src/main.ts" onChange={handleChange} />);

		expect(handleChange).not.toHaveBeenCalled();
	});

	it('emits post-change cursor with document changes', () => {
		const handleChange = vi.fn();
		const handleCursorChange = vi.fn();
		let editorView: EditorView | undefined;

		render(
			<CodeEditor
				value="const value = 1;"
				filename="/src/main.ts"
				onChange={handleChange}
				onCursorChange={handleCursorChange}
				onViewReady={(view) => {
					editorView = view;
				}}
			/>,
		);

		if (!editorView) {
			throw new Error('Expected editor view');
		}
		const view = editorView;

		act(() => {
			view.dispatch({ changes: { from: 14, to: 15, insert: '12' }, selection: { anchor: 16 } });
		});

		expect(handleChange).toHaveBeenCalledWith('const value = 12;', { line: 1, column: 17, anchorLine: 1, anchorColumn: 17 });
		expect(handleCursorChange).not.toHaveBeenCalled();
	});

	describe('goToPosition', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('scrolls to the target line centered vertically', () => {
			const scrollIntoViewSpy = vi.spyOn(EditorView, 'scrollIntoView');

			const multiLineContent = Array.from({ length: 50 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');
			const onConsumed = vi.fn();

			render(
				<CodeEditor
					value={multiLineContent}
					filename="/src/main.ts"
					goToPosition={{ line: 25, column: 5 }}
					onGoToPositionConsumed={onConsumed}
				/>,
			);

			expect(scrollIntoViewSpy).toHaveBeenCalledWith(expect.any(Number), { y: 'center' });
			expect(onConsumed).toHaveBeenCalled();
		});
	});
});
