/**
 * Panel Toggling E2E Tests
 *
 * Tests the visibility toggling of IDE panels:
 * - Terminal
 * - AI assistant
 *
 * Note: The sidebar is always visible (no toggle button).
 * Snapshots are now accessed via revert buttons on AI chat messages.
 */

import { expect, test } from 'playwright/test';

import { gotoIDE } from './helpers';

test.describe('Panel Toggling', () => {
	test('sidebar with file tree is visible', async ({ page }) => {
		await gotoIDE(page);

		await expect(page.getByText('Files')).toBeVisible();
	});

	test('terminal is visible by default', async ({ page }) => {
		await gotoIDE(page);

		// Terminal is shown by default (store default: terminalVisible: true)
		// The toggle button should say "Hide terminal"
		await expect(page.getByLabel('Hide terminal')).toBeVisible();

		// Terminal filter buttons should be visible
		await expect(page.getByRole('button', { name: 'All' })).toBeVisible();
	});

	test('clicking terminal toggle hides the terminal', async ({ page }) => {
		await gotoIDE(page);

		// Terminal is visible by default
		await expect(page.getByRole('button', { name: 'All' })).toBeVisible();

		// Hide terminal
		await page.getByLabel('Hide terminal').click();

		// Filter buttons should be gone
		await expect(page.getByRole('button', { name: 'All' })).not.toBeVisible();
		// Toggle should now say "Show terminal"
		await expect(page.getByLabel('Show terminal')).toBeVisible();
	});

	test('clicking terminal toggle again shows it', async ({ page }) => {
		await gotoIDE(page);

		// Hide terminal
		await page.getByLabel('Hide terminal').click();
		await expect(page.getByRole('button', { name: 'All' })).not.toBeVisible();

		// Show terminal
		await page.getByLabel('Show terminal').click();
		await expect(page.getByRole('button', { name: 'All' })).toBeVisible();
	});

	test('clicking AI toggle shows the AI panel', async ({ page }) => {
		await gotoIDE(page);

		// AI panel is hidden by default, AI button should be visible
		const aiButton = page.getByLabel('Toggle AI panel');
		await expect(aiButton).toBeVisible();

		await aiButton.click();

		await expect(page.getByText('AI Assistant')).toBeVisible();
	});
});
