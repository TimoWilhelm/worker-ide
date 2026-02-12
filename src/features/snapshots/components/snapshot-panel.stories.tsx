/**
 * SnapshotPanel Stories
 *
 * Since SnapshotPanel relies on useSnapshots (React Query + API),
 * we provide a QueryClientProvider decorator and let the component
 * render its built-in loading/empty states naturally.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SnapshotPanel } from './snapshot-panel';

import type { Meta, StoryObj } from '@storybook/react';

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				// Prevent refetching in Storybook
				refetchOnWindowFocus: false,
				staleTime: Infinity,
			},
		},
	});
}

const meta = {
	title: 'Features/SnapshotPanel',
	component: SnapshotPanel,
	args: {
		projectId: 'abc12345-mock-project-id',
	},
	decorators: [
		(Story) => {
			const queryClient = createTestQueryClient();
			return (
				<QueryClientProvider client={queryClient}>
					<div style={{ height: '400px', width: '320px' }}>
						<Story />
					</div>
				</QueryClientProvider>
			);
		},
	],
} satisfies Meta<typeof SnapshotPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default state - will show loading then empty (since the mock API isn't available).
 */
export const Default: Story = {};

/**
 * With a close button callback.
 */
export const WithCloseButton: Story = {
	args: {
		onClose: () => {
			// no-op for storybook
		},
	},
};
