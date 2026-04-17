import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { QueuedSteeringStrip } from './messages';

import type { ChatMessage } from '@shared/types';
import type { ReactElement } from 'react';

function renderWithProviders(ui: ReactElement) {
	return render(ui);
}

function createQueuedMessage(id: string, content: string): ChatMessage {
	return {
		id,
		role: 'user',
		parts: [{ type: 'text', content }],
		createdAt: 1,
		metadata: {
			request: {
				state: 'queued',
				mode: 'code',
				model: '@cf/moonshotai/kimi-k2.5',
			},
		},
	};
}

describe('QueuedSteeringStrip', () => {
	it('renders a compact queued count when collapsed', () => {
		renderWithProviders(
			<QueuedSteeringStrip
				messages={[
					createQueuedMessage('1', 'First queued message'),
					createQueuedMessage('2', 'Second queued message'),
					createQueuedMessage('3', 'Third queued message'),
					createQueuedMessage('4', 'Fourth queued message'),
				]}
				onRemoveMessage={() => {}}
			/>,
		);

		expect(screen.getByText('4 queued')).toBeInTheDocument();
		expect(screen.getByText('First queued message')).toBeInTheDocument();
		expect(screen.getAllByLabelText('Remove queued message')).toHaveLength(1);
	});

	it('expands on click and reveals remove actions', async () => {
		renderWithProviders(
			<QueuedSteeringStrip
				messages={[
					createQueuedMessage('1', 'First queued message'),
					createQueuedMessage('2', 'Second queued message'),
					createQueuedMessage('3', 'Third queued message'),
					createQueuedMessage('4', 'Fourth queued message'),
				]}
				onRemoveMessage={() => {}}
			/>,
		);

		const trigger = screen.getByRole('button', { name: 'Show 4 queued messages' });
		fireEvent.click(trigger);

		await waitFor(() => {
			expect(screen.getAllByLabelText('Remove queued message')).toHaveLength(4);
		});
		expect(screen.getByText('Fourth queued message')).toBeInTheDocument();
	});

	it('calls onRemoveMessage for the chosen card', async () => {
		const onRemoveMessage = vi.fn();
		renderWithProviders(
			<QueuedSteeringStrip
				messages={[createQueuedMessage('1', 'First queued message'), createQueuedMessage('2', 'Second queued message')]}
				onRemoveMessage={onRemoveMessage}
			/>,
		);

		const trigger = screen.getByRole('button', { name: 'Show 2 queued messages' });
		fireEvent.click(trigger);

		await waitFor(() => {
			expect(screen.getAllByLabelText('Remove queued message')).toHaveLength(2);
		});

		fireEvent.click(screen.getAllByLabelText('Remove queued message')[0]!);
		expect(onRemoveMessage).toHaveBeenCalledWith('1');
	});

	it('shows a dashed border for client-only queued messages', () => {
		renderWithProviders(
			<QueuedSteeringStrip
				messages={[createQueuedMessage('1', 'First queued message')]}
				localOnlyMessageIds={new Set(['1'])}
				onRemoveMessage={() => {}}
			/>,
		);

		expect(screen.getByText('First queued message').closest('.border-dashed')).toBeInTheDocument();
	});
});
