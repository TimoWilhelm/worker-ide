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

		await expect(page.getByText('Files', { exact: true })).toBeVisible();
	});

	test('utility panel is visible by default', async ({ page }) => {
		await gotoIDE(page);

		// Utility panel is shown by default
		// The collapse button should say "Hide utility panel"
		await expect(page.getByLabel('Hide utility panel')).toBeVisible();

		// The Output tab should be visible
		await expect(page.getByRole('tab', { name: 'Output' })).toBeVisible();
	});

	test('clicking utility panel toggle hides it', async ({ page }) => {
		await gotoIDE(page);

		// Utility panel is visible by default
		await expect(page.getByRole('tab', { name: 'Output' })).toBeVisible();

		// Hide utility panel
		await page.getByLabel('Hide utility panel').click();

		// Output tab should be gone
		await expect(page.getByRole('tab', { name: 'Output' })).not.toBeVisible();
		// Toggle should now say "Show output"
		await expect(page.getByLabel('Show output')).toBeVisible();
	});

	test('clicking utility panel toggle again shows it', async ({ page }) => {
		await gotoIDE(page);

		// Hide utility panel
		await page.getByLabel('Hide utility panel').click();
		await expect(page.getByRole('tab', { name: 'Output' })).not.toBeVisible();

		// Show utility panel
		await page.getByLabel('Show output').click();
		await expect(page.getByRole('tab', { name: 'Output' })).toBeVisible();
	});

	test('clicking AI toggle shows the AI panel', async ({ page }) => {
		await gotoIDE(page);

		// AI panel is hidden by default, AI button should be visible
		const aiButton = page.getByLabel('Toggle Agent panel');
		await expect(aiButton).toBeVisible();

		await aiButton.click();

		await expect(page.getByText('Agent')).toBeVisible();
	});
});
