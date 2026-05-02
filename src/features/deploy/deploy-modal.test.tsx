import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DeployModal } from './deploy-modal';

import type { ProjectMeta } from '@/lib/api-client';
import type { FileInfo } from '@shared/types';
import type { ReactElement, ReactNode } from 'react';

const DEFAULT_PROJECT_ID = 'abc123';

function createProjectMeta(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
	return {
		name: 'my-project',
		organizationId: 'org-1',
		permissions: {
			delete: true,
			updateVisibility: true,
		},
		...overrides,
	};
}

function createTestQueryClient(projectMeta?: ProjectMeta, files?: FileInfo[]) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	if (projectMeta) {
		queryClient.setQueryData(['project-meta', DEFAULT_PROJECT_ID], projectMeta);
	}
	if (files) {
		queryClient.setQueryData(['files', DEFAULT_PROJECT_ID], files);
	}

	return queryClient;
}

function renderWithQueryClient(ui: ReactElement, projectMeta?: ProjectMeta, files?: FileInfo[]) {
	const queryClient = createTestQueryClient(projectMeta, files);
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	}

	return render(ui, { wrapper: Wrapper });
}

function renderDeployModal(projectName = 'my-project', projectMeta?: ProjectMeta, files?: FileInfo[]) {
	return renderWithQueryClient(
		<DeployModal open={true} onOpenChange={vi.fn()} projectId={DEFAULT_PROJECT_ID} projectName={projectName} />,
		projectMeta,
		files,
	);
}

describe('DeployModal', () => {
	it('renders the modal title when open', () => {
		renderDeployModal();

		expect(screen.getByText('Deploy to Cloudflare')).toBeInTheDocument();
	});

	it('does not render content when closed', () => {
		renderWithQueryClient(<DeployModal open={false} onOpenChange={vi.fn()} projectId={DEFAULT_PROJECT_ID} projectName="my-project" />);

		expect(screen.queryByText('Deploy to Cloudflare')).not.toBeInTheDocument();
	});

	it('renders Account ID input', () => {
		renderDeployModal();

		expect(screen.getByLabelText('Account ID')).toBeInTheDocument();
	});

	it('renders API Token input as password field', () => {
		renderDeployModal();

		const tokenInput = screen.getByLabelText('API Token');
		expect(tokenInput).toBeInTheDocument();
		expect(tokenInput).toHaveAttribute('type', 'password');
	});

	it('renders Worker Name input with sanitized project name', () => {
		renderDeployModal('My Project');

		const nameInput = screen.getByLabelText('Worker Name');
		expect(nameInput).toHaveValue('my-project');
	});

	it('renders remember credentials checkbox', () => {
		renderDeployModal();

		expect(screen.getByLabelText('Remember credentials in this browser')).toBeInTheDocument();
	});

	it('renders Deploy button', () => {
		renderDeployModal();

		expect(screen.getByRole('button', { name: /deploy/i })).toBeInTheDocument();
	});

	it('renders Cancel button', () => {
		renderDeployModal();

		expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
	});

	it('disables Deploy button when fields are empty', () => {
		renderDeployModal();

		expect(screen.getByRole('button', { name: /deploy/i })).toBeDisabled();
	});

	it('enables Deploy button when Account ID and API Token are filled', async () => {
		const user = userEvent.setup();
		renderDeployModal();

		await user.type(screen.getByLabelText('Account ID'), 'd64471fef208e0cf9687449dc8a5878b');
		await user.type(screen.getByLabelText('API Token'), 'cfapitoken123');

		expect(screen.getByRole('button', { name: /deploy/i })).toBeEnabled();
	});

	it('shows an account ID validation error for non-hex input', async () => {
		const user = userEvent.setup();
		renderDeployModal();

		const accountIdInput = screen.getByLabelText('Account ID');
		await user.type(accountIdInput, 'not-an-account-id');
		await user.tab();

		expect(screen.getByText('Account ID must be a hexadecimal string')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /deploy/i })).toBeDisabled();
	});

	it('shows an API token validation error for whitespace', async () => {
		const user = userEvent.setup();
		renderDeployModal();

		const tokenInput = screen.getByLabelText('API Token');
		await user.type(tokenInput, 'token with spaces');
		await user.tab();

		expect(screen.getByText('API Token must not contain whitespace')).toBeInTheDocument();
	});

	it('shows a worker name validation error when the name is too long', async () => {
		const user = userEvent.setup();
		renderDeployModal();

		const workerInput = screen.getByLabelText('Worker Name');
		await user.clear(workerInput);
		await user.type(workerInput, 'a'.repeat(25));
		await user.tab();

		expect(screen.getByText('Worker name must be at most 24 characters')).toBeInTheDocument();
	});

	it('renders the Create a token link', () => {
		renderDeployModal();

		const link = screen.getByRole('link', { name: /create an account token/i });
		const href = link.getAttribute('href');
		const tokenUrl = new URL(href ?? '');
		const permissions = JSON.parse(tokenUrl.searchParams.get('permissionGroupKeys') ?? '[]');

		expect(link).toBeInTheDocument();
		expect(link).toHaveAttribute('target', '_blank');
		expect(tokenUrl.origin).toBe('https://dash.cloudflare.com');
		expect(tokenUrl.searchParams.get('to')).toBe('/:account/api-tokens');
		expect(tokenUrl.searchParams.has('accountId')).toBe(false);
		expect(tokenUrl.searchParams.has('zoneId')).toBe(false);
		expect(tokenUrl.searchParams.get('name')).toBe('Worker IDE Deploy Token');
		expect(permissions).toEqual([
			{ key: 'workers_scripts', type: 'edit' },
			{ key: 'workers_r2', type: 'edit' },
		]);
	});

	it('shows default deployment resources', () => {
		renderDeployModal();

		expect(screen.getByLabelText('Resources to deploy')).toBeInTheDocument();
		expect(screen.getByText('Worker')).toBeInTheDocument();
		expect(screen.getByText('my-project')).toBeInTheDocument();
		expect(screen.getByText('Route')).toBeInTheDocument();
		expect(screen.getByText('my-project.workers.dev')).toBeInTheDocument();
		expect(screen.queryByText('Assets')).not.toBeInTheDocument();
		expect(screen.queryByText('R2 bucket')).not.toBeInTheDocument();
	});

	it('shows static assets when index.html exists', () => {
		renderDeployModal('my-project', undefined, [{ path: '/index.html', name: 'index.html', isDirectory: false }]);

		expect(screen.getByText('Assets')).toBeInTheDocument();
		expect(screen.getByText('Static assets')).toBeInTheDocument();
	});

	it('shows R2 bucket when storage is enabled', () => {
		renderDeployModal('my-project', createProjectMeta({ bindingsConfig: { storage: true } }));

		expect(screen.getByText('R2 bucket')).toBeInTheDocument();
		expect(screen.getByText(/^my-project-storage-[\da-f]{8}$/)).toBeInTheDocument();
	});

	it('updates resource names when the worker name changes', async () => {
		const user = userEvent.setup();
		renderDeployModal('my-project', createProjectMeta({ bindingsConfig: { storage: true } }));

		const workerInput = screen.getByLabelText('Worker Name');
		await user.clear(workerInput);
		await user.type(workerInput, 'My New Worker');

		expect(screen.getByText('my-new-worker')).toBeInTheDocument();
		expect(screen.getByText('my-new-worker.workers.dev')).toBeInTheDocument();
		expect(screen.getByText(/^my-new-worker-storage-[\da-f]{8}$/)).toBeInTheDocument();
	});

	it('calls onOpenChange when Cancel is clicked', async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		renderWithQueryClient(<DeployModal open={true} onOpenChange={onOpenChange} projectId={DEFAULT_PROJECT_ID} projectName="my-project" />);

		await user.click(screen.getByRole('button', { name: /cancel/i }));

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
