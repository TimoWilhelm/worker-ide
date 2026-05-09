import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileReference } from './file-reference';

import type { ReactNode } from 'react';

const mockOpenFileTarget = vi.fn();

vi.mock('@/components/ui/tooltip', () => ({
	Tooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/lib/file-target', () => ({
	resolveFileTargetPath: (path: string, files: Array<{ path: string }>) =>
		files.find((file) => file.path === path)?.path ?? `/${path.replace(/^\.?\//, '')}`,
	useFileTargetOpener: () => mockOpenFileTarget,
}));

vi.mock('@/lib/store', () => ({
	useStore: (selector: (state: { files: Array<{ path: string }> }) => unknown) =>
		selector({
			files: [{ path: '/src/main.ts' }, { path: '/src/features/agent/components/file-reference.tsx' }],
		}),
}));

describe('FileReference', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('opens the file and reveals it in the explorer state', () => {
		render(<FileReference path="/src/features/agent/components/file-reference.tsx" />);

		fireEvent.click(screen.getByRole('button', { name: /file-reference\.tsx/i }));

		expect(mockOpenFileTarget).toHaveBeenCalledWith({ path: '/src/features/agent/components/file-reference.tsx' });
	});

	it('supports nested clickable usage without toggling the parent button', () => {
		const onClick = vi.fn();

		render(<FileReference path="/src/main.ts" interactive={false} onClick={onClick} />);

		fireEvent.click(screen.getByRole('button', { name: /main\.ts/i }));

		expect(onClick).toHaveBeenCalledOnce();
		expect(mockOpenFileTarget).toHaveBeenCalledWith({ path: '/src/main.ts' });
	});

	it('normalizes relative paths before opening them', () => {
		render(<FileReference path="src/main.ts" />);

		fireEvent.click(screen.getByRole('button', { name: /main\.ts/i }));

		expect(mockOpenFileTarget).toHaveBeenCalledWith({ path: 'src/main.ts' });
	});
});
