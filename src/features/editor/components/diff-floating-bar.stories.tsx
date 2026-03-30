import { fn } from 'storybook/test';

import { DiffFloatingBar } from './diff-floating-bar';

import type { DiffFloatingBarProperties } from './diff-floating-bar';
import type { ChangeGroup } from '../lib/diff-decorations';
import type { Meta, StoryObj } from '@storybook/react-vite';

function createMockChangeGroups(count: number): ChangeGroup[] {
	return Array.from({ length: count }, (_, index) => ({
		index,
		hunks: [
			{
				type: 'added' as const,
				startLine: 10 + index * 20,
				beforeStartLine: 10 + index * 20,
				lineCount: 3,
				lines: ['+ line 1', '+ line 2', '+ line 3'],
			},
		],
		startLine: 10 + index * 20,
	}));
}

const meta = {
	title: 'Features/Editor/DiffFloatingBar',
	component: DiffFloatingBar,
	parameters: {
		layout: 'centered',
	},
	args: {
		onNavigate: fn(),
		onAcceptAll: fn(),
		onRejectAll: fn(),
		path: '/src/example.ts',
		isReverting: false,
		canReject: true,
	},
	decorators: [
		(Story) => (
			<div className="relative h-32 w-[500px]">
				<Story />
			</div>
		),
	],
} satisfies Meta<DiffFloatingBarProperties>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		changeGroups: createMockChangeGroups(5),
		hunkStatuses: ['approved', 'approved', 'pending', 'pending', 'pending'],
		currentGroupIndex: 2,
	},
};

export const SingleEdit: Story = {
	args: {
		changeGroups: createMockChangeGroups(1),
		hunkStatuses: ['pending'],
		currentGroupIndex: 0,
	},
};

export const AllReviewed: Story = {
	args: {
		changeGroups: createMockChangeGroups(5),
		hunkStatuses: ['approved', 'approved', 'rejected', 'approved', 'approved'],
		currentGroupIndex: 0,
	},
};

export const Reverting: Story = {
	args: {
		changeGroups: createMockChangeGroups(3),
		hunkStatuses: ['pending', 'pending', 'pending'],
		currentGroupIndex: 1,
		isReverting: true,
	},
};

export const CannotReject: Story = {
	args: {
		changeGroups: createMockChangeGroups(3),
		hunkStatuses: ['pending', 'pending', 'pending'],
		currentGroupIndex: 0,
		canReject: false,
	},
};
