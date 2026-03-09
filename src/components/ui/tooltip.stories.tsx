import { expect, userEvent, within } from 'storybook/test';

import { Button } from './button';
import { Tooltip } from './tooltip';

import type { Meta, StoryObj } from '@storybook/react-vite';

/**
 * Helper: hover the trigger and wait for the tooltip to appear in the DOM.
 * Radix Tooltip uses a global provider with a skip-delay mechanism.
 * When stories run sequentially the previous tooltip may still be
 * closing, so we unhover first, wait a tick, then hover to ensure a
 * clean open.
 */
async function hoverAndFindTooltip(canvasElement: HTMLElement, buttonName: RegExp): Promise<HTMLElement> {
	const canvas = within(canvasElement);
	const button = canvas.getByRole('button', { name: buttonName });

	// Ensure any lingering tooltip from a prior story is dismissed
	await userEvent.unhover(button);
	// Small settle time for Radix to tear down the previous tooltip
	await new Promise((resolve) => setTimeout(resolve, 50));

	await userEvent.hover(button);

	const body = within(document.body);
	return body.findByRole('tooltip', undefined, { timeout: 3000 });
}

const meta = {
	title: 'UI/Tooltip',
	component: Tooltip,
	parameters: {
		layout: 'centered',
	},
	args: {
		children: undefined,
		content: '',
	},
	decorators: [
		(Story) => (
			<div className="p-10">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	render: () => (
		<Tooltip content="Add to library" side="top" delayDuration={0}>
			<Button variant="outline">Hover</Button>
		</Tooltip>
	),
	play: async ({ canvasElement }) => {
		const tooltipContent = await hoverAndFindTooltip(canvasElement, /Hover/i);
		await expect(tooltipContent).toHaveTextContent('Add to library');
	},
};

export const Right: Story = {
	render: () => (
		<Tooltip content="Configuration" side="right" delayDuration={0}>
			<Button variant="outline">Settings</Button>
		</Tooltip>
	),
	play: async ({ canvasElement }) => {
		const tooltipContent = await hoverAndFindTooltip(canvasElement, /Settings/i);
		await expect(tooltipContent).toHaveTextContent('Configuration');
	},
};

export const Bottom: Story = {
	render: () => (
		<Tooltip content="Save changes" side="bottom" delayDuration={0}>
			<Button variant="outline">Save</Button>
		</Tooltip>
	),
	play: async ({ canvasElement }) => {
		const tooltipContent = await hoverAndFindTooltip(canvasElement, /Save/i);
		await expect(tooltipContent).toHaveTextContent('Save changes');
	},
};

export const Left: Story = {
	render: () => (
		<Tooltip content="Undo last action" side="left" delayDuration={0}>
			<Button variant="outline">Undo</Button>
		</Tooltip>
	),
	play: async ({ canvasElement }) => {
		const tooltipContent = await hoverAndFindTooltip(canvasElement, /Undo/i);
		await expect(tooltipContent).toHaveTextContent('Undo last action');
	},
};
