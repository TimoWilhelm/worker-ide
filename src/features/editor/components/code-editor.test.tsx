import { EditorView } from '@codemirror/view';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodeEditor } from './code-editor';

describe('CodeEditor', () => {
	it('does not emit onChange when external value updates replace the document', () => {
		const handleChange = vi.fn();
		const { rerender } = render(<CodeEditor value="const before = true;" filename="/src/main.ts" onChange={handleChange} />);

		rerender(<CodeEditor value="const after = true;" filename="/src/main.ts" onChange={handleChange} />);

		expect(handleChange).not.toHaveBeenCalled();
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
