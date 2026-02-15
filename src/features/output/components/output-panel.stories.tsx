import { OutputPanel } from './output-panel';

import type { Meta, StoryObj } from '@storybook/react';

const meta = {
	title: 'Features/OutputPanel',
	component: OutputPanel,
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
} satisfies Meta<typeof OutputPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithClassName: Story = {
	args: {
		className: 'border border-border rounded-lg',
	},
};
