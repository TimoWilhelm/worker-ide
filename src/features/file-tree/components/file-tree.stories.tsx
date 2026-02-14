import { fn } from '@storybook/test';

import { FileTree } from './file-tree';

import type { Meta, StoryObj } from '@storybook/react';

const meta = {
	title: 'Features/FileTree',
	component: FileTree,
	args: {
		onFileSelect: fn(),
		onDirectoryToggle: fn(),
	},
	decorators: [
		(Story) => (
			<div className="h-[500px] w-[240px] border border-border bg-bg-secondary">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof FileTree>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleFiles = [
	'/src/main.ts',
	'/src/app.tsx',
	'/src/index.css',
	'/src/lib/utils.ts',
	'/src/lib/store.ts',
	'/src/lib/api-client.ts',
	'/src/components/ui/button.tsx',
	'/src/components/ui/spinner.tsx',
	'/src/features/editor/components/code-editor.tsx',
	'/src/features/editor/components/file-tabs.tsx',
	'/worker/index.ts',
	'/worker/routes/file-routes.ts',
	'/worker/routes/ai-routes.ts',
	'/shared/types.ts',
	'/shared/constants.ts',
	'/index.html',
	'/package.json',
	'/tsconfig.json',
];

export const Default: Story = {
	args: {
		files: sampleFiles,
		selectedFile: '/src/app.tsx',
		expandedDirectories: new Set(['/src', '/src/lib', '/src/components', '/src/components/ui']),
	},
};

export const AllCollapsed: Story = {
	args: {
		files: sampleFiles,
		selectedFile: undefined,
		expandedDirectories: new Set(),
	},
};

export const AllExpanded: Story = {
	args: {
		files: sampleFiles,
		selectedFile: '/src/lib/store.ts',
		expandedDirectories: new Set([
			'/src',
			'/src/lib',
			'/src/components',
			'/src/components/ui',
			'/src/features',
			'/src/features/editor',
			'/src/features/editor/components',
			'/worker',
			'/worker/routes',
			'/shared',
		]),
	},
};

export const Empty: Story = {
	args: {
		files: [],
		selectedFile: undefined,
		expandedDirectories: new Set(),
	},
};

export const FlatFiles: Story = {
	args: {
		files: ['/index.html', '/package.json', '/tsconfig.json', '/vite.config.ts', '/README.md'],
		selectedFile: '/package.json',
		expandedDirectories: new Set(),
	},
};

export const DeeplyNested: Story = {
	args: {
		files: [
			'/src/features/editor/components/code-editor.tsx',
			'/src/features/editor/components/file-tabs.tsx',
			'/src/features/editor/hooks/use-file-content.ts',
			'/src/features/editor/lib/extensions.ts',
			'/src/features/editor/index.ts',
			'/src/features/ai-assistant/components/ai-panel.tsx',
			'/src/features/ai-assistant/index.ts',
			'/src/features/preview/components/preview-panel.tsx',
			'/src/features/preview/index.ts',
		],
		selectedFile: '/src/features/editor/components/code-editor.tsx',
		expandedDirectories: new Set([
			'/src',
			'/src/features',
			'/src/features/editor',
			'/src/features/editor/components',
			'/src/features/ai-assistant',
			'/src/features/ai-assistant/components',
			'/src/features/preview',
			'/src/features/preview/components',
		]),
	},
};
