/**
 * IDE Layout E2E Tests
 *
 * Verifies that the main IDE shell loads correctly with all major sections visible.
 */

import { expect, test } from 'playwright/test';

import { gotoIDE } from './helpers';

test.describe('IDE Layout', () => {
	test('renders the header with project info', async ({ page }) => {
		const projectId = await gotoIDE(page);

		// Header should show "Worker IDE" title
		await expect(page.getByRole('heading', { name: 'Worker IDE' })).toBeVisible();

		// Project ID snippet should be visible (first 8 chars)
		await expect(page.getByText(`Project: ${projectId.slice(0, 8)}...`)).toBeVisible();
	});

	test('renders the sidebar with explorer label', async ({ page }) => {
		await gotoIDE(page);

		// Explorer label in sidebar header
		await expect(page.getByText('Explorer')).toBeVisible();
	});

	test('shows empty editor placeholder when no file is open', async ({ page }) => {
		await gotoIDE(page);

		await expect(page.getByText('Select a file to edit')).toBeVisible();
	});

	test('renders the status bar', async ({ page }) => {
		await gotoIDE(page);

		// Status bar is a <footer> element
		const footer = page.locator('footer');
		await expect(footer).toBeVisible();
	});

	test('shows download button in header', async ({ page }) => {
		await gotoIDE(page);

		await expect(page.getByRole('button', { name: /download/i })).toBeVisible();
	});
});
