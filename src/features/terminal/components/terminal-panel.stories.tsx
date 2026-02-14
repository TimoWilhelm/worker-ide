import { TerminalPanel } from './terminal-panel';

import type { Meta, StoryObj } from '@storybook/react';

const meta = {
	title: 'Features/TerminalPanel',
	component: TerminalPanel,
	args: {
		projectId: 'abc12345-mock-project-id',
	},
	decorators: [
		(Story) => (
			<div style={{ height: '300px', width: '600px' }}>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof TerminalPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithClassName: Story = {
	args: {
		className: 'border border-border rounded-lg',
	},
};
