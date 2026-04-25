import { MemoryRouter } from 'react-router';

import { OrgSwitcher } from './org-switcher';

import type { Meta, StoryObj } from '@storybook/react-vite';

const mockOrganizations = [
	{ id: 'org-1', name: 'Acme Corp', slug: 'acme-corp' },
	{ id: 'org-2', name: 'Globex Inc', slug: 'globex' },
	{ id: 'org-3', name: 'Initech', slug: 'initech' },
];

const meta = {
	title: 'Features/Org/OrgSwitcher',
	component: OrgSwitcher,
	decorators: [
		(Story) => (
			<MemoryRouter>
				<div className="flex justify-end p-4">
					<Story />
				</div>
			</MemoryRouter>
		),
	],
	parameters: {
		layout: 'centered',
	},
	args: {
		organizations: mockOrganizations,
		currentOrganizationId: 'org-1',
		currentOrganizationName: 'Acme Corp',
	},
} satisfies Meta<typeof OrgSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const DifferentActiveOrg: Story = {
	args: {
		currentOrganizationId: 'org-2',
		currentOrganizationName: 'Globex Inc',
	},
};

export const SingleOrganization: Story = {
	args: {
		organizations: [{ id: 'org-1', name: 'My Org', slug: 'my-org' }],
		currentOrganizationId: 'org-1',
		currentOrganizationName: 'My Org',
	},
};

export const LongOrganizationName: Story = {
	args: {
		organizations: [
			{ id: 'org-1', name: 'A Very Long Organization Name That Should Truncate', slug: 'long-org' },
			...mockOrganizations.slice(1),
		],
		currentOrganizationId: 'org-1',
		currentOrganizationName: 'A Very Long Organization Name That Should Truncate',
	},
};

export const NoSlug: Story = {
	args: {
		organizations: [
			{ id: 'org-1', name: 'No Slug Org', slug: 'no-slug-org' },
			{ id: 'org-2', name: 'Also No Slug', slug: 'also-no-slug' },
		],
		currentOrganizationId: 'org-1',
		currentOrganizationName: 'No Slug Org',
	},
};
