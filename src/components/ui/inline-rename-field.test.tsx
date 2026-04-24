import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { InlineRenameField } from './inline-rename-field';

function TestHarness({ onSubmitValue }: { onSubmitValue?: (value: string) => void }) {
	const [displayValue, setDisplayValue] = useState('Project One');
	const [isEditing, setIsEditing] = useState(false);

	return (
		<InlineRenameField
			isEditing={isEditing}
			displayValue={displayValue}
			inputValue={displayValue}
			inputAriaLabel="Rename test item"
			onStartEditing={() => {
				setIsEditing(true);
			}}
			onSubmit={(value) => {
				setIsEditing(false);

				const trimmed = value.trim();
				if (!trimmed || trimmed === displayValue) {
					return;
				}

				onSubmitValue?.(trimmed);
				setDisplayValue(trimmed);
			}}
			onCancel={() => setIsEditing(false)}
			className="min-h-8 w-full"
			inputClassName="h-8 rounded-md border border-border px-2"
		>
			{({ displayValue, startEditing }) => (
				<div className="flex items-center gap-2">
					<span data-testid="display-value">{displayValue}</span>
					<button type="button" onClick={startEditing}>
						Rename test item
					</button>
				</div>
			)}
		</InlineRenameField>
	);
}

describe('InlineRenameField', () => {
	it('overlays the input while keeping the preview in layout', async () => {
		const user = userEvent.setup();
		render(<TestHarness />);

		await user.click(screen.getByRole('button', { name: 'Rename test item' }));

		const input = screen.getByRole('textbox', { name: 'Rename test item' });
		await waitFor(() => expect(input).toHaveFocus());
		expect(input.parentElement?.className).toContain('absolute');

		const previewWrapper = screen.getByTestId('display-value').closest('[aria-hidden="true"]');
		expect(previewWrapper).not.toBeNull();
		expect(previewWrapper?.className).toContain('invisible');
	});

	it('shows the optimistic value immediately after submit', async () => {
		const user = userEvent.setup();
		const onSubmitValue = vi.fn();
		render(<TestHarness onSubmitValue={onSubmitValue} />);

		await user.click(screen.getByRole('button', { name: 'Rename test item' }));
		const input = screen.getByRole('textbox', { name: 'Rename test item' });
		fireEvent.change(input, { target: { value: 'Project Two' } });

		fireEvent.blur(input);

		expect(onSubmitValue).toHaveBeenCalledWith('Project Two');
		await waitFor(() => expect(screen.getByTestId('display-value')).toHaveTextContent('Project Two'));
		expect(screen.queryByRole('textbox', { name: 'Rename test item' })).not.toBeInTheDocument();
	});

	it('cancels on escape without submitting', async () => {
		const user = userEvent.setup();
		const onSubmitValue = vi.fn();
		render(<TestHarness onSubmitValue={onSubmitValue} />);

		await user.click(screen.getByRole('button', { name: 'Rename test item' }));
		const input = screen.getByRole('textbox', { name: 'Rename test item' });
		fireEvent.change(input, { target: { value: 'Project Two' } });

		fireEvent.keyDown(input, { key: 'Escape' });
		fireEvent.blur(input);

		expect(onSubmitValue).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.getByTestId('display-value')).toHaveTextContent('Project One'));
	});
});
