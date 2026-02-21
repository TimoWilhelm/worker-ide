import { fn } from 'storybook/test';

import { FileTabs } from './file-tabs';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'Features/Editor/FileTabs',
	component: FileTabs,
	args: {
		onSelect: fn(),
		onClose: fn(),
	},
} satisfies Meta<typeof FileTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleTab: Story = {
	args: {
		tabs: [{ path: '/src/main.ts' }],
		activeTab: '/src/main.ts',
	},
};

export const MultipleTabs: Story = {
	args: {
		tabs: [
			{ path: '/src/main.ts' },
			{ path: '/src/app.tsx' },
			{ path: '/src/index.css' },
			{ path: '/index.html' },
			{ path: '/package.json' },
		],
		activeTab: '/src/app.tsx',
	},
};

export const WithUnsavedChanges: Story = {
	args: {
		tabs: [
			{ path: '/src/main.ts', hasUnsavedChanges: true },
			{ path: '/src/app.tsx' },
			{ path: '/src/index.css', hasUnsavedChanges: true },
		],
		activeTab: '/src/main.ts',
	},
};

export const NoTabs: Story = {
	args: {
		tabs: [],
		activeTab: undefined,
	},
};

export const ManyTabs: Story = {
	args: {
		tabs: [
			{ path: '/src/main.ts' },
			{ path: '/src/app.tsx' },
			{ path: '/src/index.css' },
			{ path: '/src/lib/utils.ts' },
			{ path: '/src/lib/store.ts' },
			{ path: '/src/lib/api-client.ts' },
			{ path: '/src/components/ui/button.tsx' },
			{ path: '/src/components/ui/spinner.tsx' },
			{ path: '/worker/index.ts' },
			{ path: '/shared/types.ts' },
		],
		activeTab: '/src/lib/store.ts',
	},
};

export const FileTypes: Story = {
	args: {
		tabs: [
			{ path: '/src/component.tsx' },
			{ path: '/src/script.js' },
			{ path: '/src/style.css' },
			{ path: '/index.html' },
			{ path: '/package.json' },
			{ path: '/README.md' },
			{ path: '/data.txt' },
		],
		activeTab: '/src/component.tsx',
	},
};
