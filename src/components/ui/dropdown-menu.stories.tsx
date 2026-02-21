import { expect, userEvent, within } from '@storybook/test';

import { Button } from './button';
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuLabel,
	DropdownMenuGroup,
} from './dropdown-menu';

import type { Meta, StoryObj } from '@storybook/react';

const meta = {
	title: 'UI/DropdownMenu',
	component: DropdownMenu,
	parameters: {
		layout: 'centered',
	},
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	render: () => (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline">Open Menu</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuLabel>My Account</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem>Profile</DropdownMenuItem>
					<DropdownMenuItem>Billing</DropdownMenuItem>
					<DropdownMenuItem>Settings</DropdownMenuItem>
					<DropdownMenuItem disabled>Keyboard shortcuts</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem>Log out</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const trigger = canvas.getByRole('button', { name: /Open Menu/i });
		await userEvent.click(trigger);

		const body = within(document.body);
		const menu = await body.findByRole('menu');
		await expect(menu).toBeInTheDocument();

		const profileItem = body.getByRole('menuitem', { name: /Profile/i });
		await expect(profileItem).toBeInTheDocument();

		// Close the menu
		await userEvent.keyboard('{Escape}');
	},
};
