import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { CreateOrgModal } from './create-org-modal';

describe('CreateOrgModal', () => {
	it('shows the maximum organizations message when the cap is reached', () => {
		render(
			<MemoryRouter>
				<CreateOrgModal open onOpenChange={() => {}} freeOrganizationCount={1} maxFreeOrganizations={1} />
			</MemoryRouter>,
		);

		expect(screen.getByText('Maximum number of organizations reached.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
	});

	it('does not show the limit message when the user can still create an organization', () => {
		render(
			<MemoryRouter>
				<CreateOrgModal open onOpenChange={() => {}} freeOrganizationCount={0} maxFreeOrganizations={1} />
			</MemoryRouter>,
		);

		expect(screen.queryByText('Maximum number of organizations reached.')).not.toBeInTheDocument();
	});
});
