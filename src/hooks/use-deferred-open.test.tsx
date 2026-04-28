import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useDeferredOpen } from './use-deferred-open';

describe('useDeferredOpen', () => {
	it('keeps dialogOpen true until exit completes after closing', () => {
		const { result, rerender } = renderHook(({ open }: { open: boolean }) => useDeferredOpen(open), {
			initialProps: { open: true },
		});

		expect(result.current.dialogOpen).toBe(true);
		expect(result.current.show).toBe(true);

		rerender({ open: false });

		expect(result.current.dialogOpen).toBe(true);
		expect(result.current.show).toBe(false);

		act(() => {
			result.current.onExitComplete();
		});

		expect(result.current.dialogOpen).toBe(false);
		expect(result.current.show).toBe(false);
	});

	it('keeps dialogOpen true while opening', () => {
		const { result, rerender } = renderHook(({ open }: { open: boolean }) => useDeferredOpen(open), {
			initialProps: { open: false },
		});

		expect(result.current.dialogOpen).toBe(false);
		expect(result.current.show).toBe(false);

		rerender({ open: true });

		expect(result.current.dialogOpen).toBe(true);
		expect(result.current.show).toBe(true);
	});
});
