/**
 * Component tests for DeployModal.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DeployModal } from './deploy-modal';

describe('DeployModal', () => {
	it('renders the modal title when open', () => {
		render(<DeployModal open={true} onOpenChange={vi.fn()} projectId="abc123" projectName="my-project" />);

		expect(screen.getByText('Deploy to Cloudflare')).toBeInTheDocument();
	});

	it('does not render content when closed', () => {
		render(<DeployModal open={false} onOpenChange={vi.fn()} projectId="abc123" projectName="my-project" />);

		expect(screen.queryByText('Deploy to Cloudflare')).not.toBeInTheDocument();
	});

	it('renders Account ID input', () => {
		render(<DeployModal open={true} onOpenChange={vi.fn()} projectId="abc123" projectName="my-project" />);

		expect(screen.getByLabelText('Account ID')).toBeInTheDocument();
	});

	it('renders API Token input as password field', () => {
		render(<DeployModal open={true} onOpenChange={vi.fn()} projectId="abc123" projectName="my-project" />);

		const tokenInput = screen.getByLabelText('API Token');
		expect(tokenInput).toBeInTheDocument();
		expect(tokenInput).toHaveAttribute('type', 'password');
	});

	it('renders Worker Name input with sanitized project name', () => {
		render(<DeployModal open={true} onOpenChange={vi.fn()} projectId="abc123" projectName="My Project" />);

		const nameInput = screen.getByLabelText('Worker Name');
		expect(nameInput).toHaveValue('my-project');
	});

	it('renders remember credentials checkbox', () => {
		render(<DeployModal open={true} onOpenChange={vi.fn()} projectId="abc123" projectName="my-project" />);

		expect(screen.getByLabelText('Remember credentials in this browser')).toBeInTheDocument();
	});

	it('renders Deploy button', () => {
		render(<DeployModal open={true} onOpenChange={vi.fn()} projectId="abc123" projectName="my-project" />);

		expect(screen.getByRole('button', { name: /deploy/i })).toBeInTheDocument();
	});

	it('renders Cancel button', () => {
		render(<DeployModal open={true} onOpenChange={vi.fn()} projectId="abc123" projectName="my-project" />);

		expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
	});

	it('disables Deploy button when fields are empty', () => {
		render(<DeployModal open={true} onOpenChange={vi.fn()} projectId="abc123" projectName="my-project" />);

		expect(screen.getByRole('button', { name: /deploy/i })).toBeDisabled();
	});

	it('enables Deploy button when Account ID and API Token are filled', async () => {
		const user = userEvent.setup();
		render(<DeployModal open={true} onOpenChange={vi.fn()} projectId="abc123" projectName="my-project" />);

		await user.type(screen.getByLabelText('Account ID'), 'test-account-id');
		await user.type(screen.getByLabelText('API Token'), 'test-api-token');

		expect(screen.getByRole('button', { name: /deploy/i })).toBeEnabled();
	});

	it('renders the Create a token link', () => {
		render(<DeployModal open={true} onOpenChange={vi.fn()} projectId="abc123" projectName="my-project" />);

		const link = screen.getByRole('link', { name: /create a token/i });
		expect(link).toBeInTheDocument();
		expect(link).toHaveAttribute('target', '_blank');
	});

	it('calls onOpenChange when Cancel is clicked', async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		render(<DeployModal open={true} onOpenChange={onOpenChange} projectId="abc123" projectName="my-project" />);

		await user.click(screen.getByRole('button', { name: /cancel/i }));

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
