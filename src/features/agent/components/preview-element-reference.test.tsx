import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewElementReference } from './preview-element-reference';

import type { PreviewElementReference as PreviewElementReferenceValue } from '@shared/types';

const mockClearPreviewElementHighlight = vi.fn();
const mockRevealPreviewElement = vi.fn();
const mockResolvePreviewElement = vi.fn();
const mockSetActiveMobilePanel = vi.fn();

let isMobile = false;
let restoreRequestAnimationFrame: (() => void) | undefined;

vi.mock('@/features/preview/preview-iframe-reference', () => ({
	clearPreviewElementHighlight: () => mockClearPreviewElementHighlight(),
	revealPreviewElement: (...parameters: unknown[]) => mockRevealPreviewElement(...parameters),
	resolvePreviewElement: (...parameters: unknown[]) => mockResolvePreviewElement(...parameters),
}));

vi.mock('@/hooks', () => ({
	useIsMobile: () => isMobile,
}));

vi.mock('@/lib/store', () => ({
	useStore: (selector: (state: { setActiveMobilePanel: typeof mockSetActiveMobilePanel }) => unknown) =>
		selector({ setActiveMobilePanel: mockSetActiveMobilePanel }),
}));

const reference: PreviewElementReferenceValue = {
	tagName: 'button',
	primarySelector: '#submit',
	locatorCandidates: [],
	accessibleName: 'Submit order',
};

describe('PreviewElementReference', () => {
	beforeEach(() => {
		isMobile = false;
		const requestAnimationFrameSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		restoreRequestAnimationFrame = () => {
			requestAnimationFrameSpy.mockRestore();
		};
		vi.clearAllMocks();
	});

	afterEach(() => {
		restoreRequestAnimationFrame?.();
	});

	it('reveals the referenced element on desktop hover and clears it on leave', () => {
		render(<PreviewElementReference reference={reference} />);

		const button = screen.getByRole('button', { name: /button/i });
		expect(button).toHaveTextContent('<button>');
		expect(button).toHaveTextContent('Submit order');
		fireEvent.mouseEnter(button);

		expect(mockRevealPreviewElement).toHaveBeenCalledWith(reference, { scroll: 'if-needed' });

		fireEvent.mouseLeave(button);
		expect(mockClearPreviewElementHighlight).toHaveBeenCalledOnce();
	});

	it('switches mobile to preview and keeps the highlight sticky on click', async () => {
		isMobile = true;
		mockResolvePreviewElement.mockResolvedValue(true);

		render(<PreviewElementReference reference={reference} />);

		fireEvent.click(screen.getByRole('button', { name: /button/i }));

		await waitFor(() => {
			expect(mockSetActiveMobilePanel).toHaveBeenCalledWith('preview');
		});

		expect(mockRevealPreviewElement).toHaveBeenCalledWith(reference, { scroll: 'if-needed', sticky: true });
	});

	it('switches mobile to preview even when element resolution is unavailable', async () => {
		isMobile = true;
		mockResolvePreviewElement.mockImplementation(async () => {});

		render(<PreviewElementReference reference={reference} />);

		fireEvent.click(screen.getByRole('button', { name: /button/i }));

		await waitFor(() => {
			expect(mockSetActiveMobilePanel).toHaveBeenCalledWith('preview');
		});

		expect(mockRevealPreviewElement).toHaveBeenCalledWith(reference, { scroll: 'if-needed', sticky: true });
		expect(mockClearPreviewElementHighlight).not.toHaveBeenCalled();
	});

	it('does not clear the sticky highlight on mobile blur', async () => {
		isMobile = true;
		mockResolvePreviewElement.mockResolvedValue(true);

		render(<PreviewElementReference reference={reference} />);

		const button = screen.getByRole('button', { name: /button/i });
		fireEvent.click(button);
		fireEvent.blur(button);

		await waitFor(() => {
			expect(mockSetActiveMobilePanel).toHaveBeenCalledWith('preview');
		});

		expect(mockClearPreviewElementHighlight).not.toHaveBeenCalled();
	});
});
