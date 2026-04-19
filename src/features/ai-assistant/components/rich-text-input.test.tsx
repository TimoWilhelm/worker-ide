import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { serializePreviewElementReference } from '@/lib/preview-element-reference';

import { RichTextInput, type RichTextInputHandle } from './rich-text-input';

import type { InputSegment } from '../lib/input-segments';

const previewReference = {
	tagName: 'div',
	primarySelector: '#hero',
	locatorCandidates: [],
};

function ControlledRichTextInput({
	initialSegments = [],
	inputReference,
}: {
	initialSegments?: InputSegment[];
	inputReference?: React.Ref<RichTextInputHandle>;
}) {
	const [segments, setSegments] = useState<InputSegment[]>(initialSegments);

	return <RichTextInput ref={inputReference} segments={segments} onSegmentsChange={setSegments} onCursorChange={() => {}} />;
}

describe('RichTextInput', () => {
	it('restores the cursor to a requested offset', () => {
		const reference = createRef<RichTextInputHandle>();
		render(
			<RichTextInput
				ref={reference}
				segments={[{ type: 'text', value: 'hello world' }]}
				onSegmentsChange={() => {}}
				onCursorChange={() => {}}
			/>,
		);

		act(() => {
			reference.current?.focus();
			reference.current?.setCursorPosition(6);
		});

		const selection = globalThis.getSelection();
		expect(selection?.anchorNode?.textContent).toBe('hello world');
		expect(selection?.anchorOffset).toBe(6);
	});

	it('moves the cursor to the inline text tail after a preview element', () => {
		const reference = createRef<RichTextInputHandle>();
		render(
			<RichTextInput
				ref={reference}
				segments={[
					{ type: 'preview-element', ...previewReference },
					{ type: 'text', value: ' ' },
				]}
				onSegmentsChange={() => {}}
				onCursorChange={() => {}}
			/>,
		);

		act(() => {
			reference.current?.focus();
			reference.current?.moveCursorToEnd();
		});

		const selection = globalThis.getSelection();
		expect(selection?.anchorNode?.textContent).toBe(' ');
		expect(selection?.anchorOffset).toBe(1);
	});

	it('normalizes a stray leading br before a preview pill back into inline content', async () => {
		const { getByRole } = render(<ControlledRichTextInput />);
		const textbox = getByRole('textbox');

		act(() => {
			textbox.innerHTML = `<br><span data-preview-element-reference="${serializePreviewElementReference(previewReference)}" contenteditable="false"></span>`;
		});

		fireEvent.input(textbox);

		await waitFor(() => {
			expect(textbox.querySelector('br')).toBeNull();
			expect(textbox.querySelector('[data-preview-element-reference]')).not.toBeNull();
		});
	});
});
