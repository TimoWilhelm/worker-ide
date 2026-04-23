import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { CreateOrgModal } from './create-org-modal';

describe('CreateOrgModal', () => {
	it('shows the free-plan limit message when the owner org cap is reached', () => {
		render(
			<MemoryRouter>
				<CreateOrgModal open onOpenChange={() => {}} ownedOrganizationCount={1} maxOrganizations={1} />
			</MemoryRouter>,
		);

		expect(screen.getByText('You have reached the maximum number of organizations.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
	});

	it('does not show the limit message when the user can still create an organization', () => {
		render(
			<MemoryRouter>
				<CreateOrgModal open onOpenChange={() => {}} ownedOrganizationCount={0} maxOrganizations={1} />
			</MemoryRouter>,
		);

		expect(screen.queryByText('You have reached the maximum number of organizations.')).not.toBeInTheDocument();
	});
});
