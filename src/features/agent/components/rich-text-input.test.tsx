import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePreviewElement } from '@/features/preview/preview-iframe-reference';
import { serializePreviewElementReference } from '@/lib/preview-element-reference';

import { RichTextInput, type RichTextInputHandle } from './rich-text-input';

import type { InputSegment } from '../lib/input-segments';

const mockActivateReference = vi.fn();
const mockClearReferenceHighlight = vi.fn();
const mockHoverReference = vi.fn();
const mockOpenFileTarget = vi.fn();

vi.mock('@/lib/file-target', () => ({
	useFileTargetOpener: () => mockOpenFileTarget,
}));

vi.mock('@/features/agent/lib/reference-actions', () => ({
	usePreviewReferenceInteractions: () => ({
		activateReference: mockActivateReference,
		clearReferenceHighlight: mockClearReferenceHighlight,
		hoverReference: mockHoverReference,
		isMobile: false,
	}),
}));

vi.mock('@/features/preview/preview-iframe-reference', () => ({
	resolvePreviewElement: vi.fn(),
}));

const previewReference = {
	tagName: 'div',
	primarySelector: '#hero',
	locatorCandidates: [],
	accessibleName: 'Hero section content',
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
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolvePreviewElement).mockResolvedValue(true);
	});

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

	it('renders draft reference pills as buttons and prioritizes the preview tag label', () => {
		const { getByRole } = render(
			<ControlledRichTextInput
				initialSegments={[
					{ type: 'mention', path: '/src/main.ts' },
					{ type: 'text', value: ' ' },
					{ type: 'preview-element', ...previewReference },
				]}
			/>,
		);

		const textbox = getByRole('textbox');
		const fileButton = textbox.querySelector('[data-mention-path]');
		const previewButton = textbox.querySelector('[data-preview-element-reference]');

		expect(fileButton?.tagName).toBe('BUTTON');
		expect(previewButton?.tagName).toBe('BUTTON');
		expect(previewButton?.querySelectorAll('span')[1]?.textContent).toBe('<div>');
		expect(previewButton?.querySelectorAll('span')[2]?.textContent).toBe('Hero section content');
	});

	it('opens file draft pills through the shared reference action', () => {
		const { getByRole } = render(<ControlledRichTextInput initialSegments={[{ type: 'mention', path: '/src/main.ts' }]} />);
		const textbox = getByRole('textbox');

		fireEvent.click(textbox.querySelector('[data-mention-path]')!);

		expect(mockOpenFileTarget).toHaveBeenCalledWith({ path: '/src/main.ts' });
	});

	it('reveals preview draft pills through the shared reference action', () => {
		const { getByRole } = render(<ControlledRichTextInput initialSegments={[{ type: 'preview-element', ...previewReference }]} />);
		const textbox = getByRole('textbox');

		fireEvent.click(textbox.querySelector('[data-preview-element-reference]')!);

		expect(mockActivateReference).toHaveBeenCalledWith(previewReference, expect.any(Function));
	});

	it('crosses out draft preview pills when the referenced element cannot be resolved', async () => {
		vi.mocked(resolvePreviewElement).mockResolvedValue(false);

		const { getByRole } = render(<ControlledRichTextInput initialSegments={[{ type: 'preview-element', ...previewReference }]} />);
		const textbox = getByRole('textbox');

		await waitFor(() => {
			expect(textbox.querySelector('[data-preview-element-reference]')).toHaveClass('line-through', 'opacity-65');
		});
	});
});
