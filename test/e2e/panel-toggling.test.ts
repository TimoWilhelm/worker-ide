/**
 * Panel Toggling E2E Tests
 *
 * Tests the visibility toggling of IDE panels:
 * - Sidebar (file tree)
 * - Terminal
 * - AI assistant
 * - Snapshot history
 */

import { expect, test } from 'playwright/test';

import { gotoIDE } from './helpers';

test.describe('Panel Toggling', () => {
	test('sidebar is visible by default', async ({ page }) => {
		await gotoIDE(page);

		await expect(page.getByText('Explorer')).toBeVisible();
	});

	test('clicking sidebar toggle hides the sidebar', async ({ page }) => {
		await gotoIDE(page);

		await expect(page.getByText('Explorer')).toBeVisible();

		await page.getByLabel('Hide sidebar').click();

		await expect(page.getByText('Explorer')).not.toBeVisible();
	});

	test('clicking sidebar toggle again shows the sidebar', async ({ page }) => {
		await gotoIDE(page);

		// Hide sidebar
		await page.getByLabel('Hide sidebar').click();
		await expect(page.getByText('Explorer')).not.toBeVisible();

		// Show sidebar
		await page.getByLabel('Show sidebar').click();
		await expect(page.getByText('Explorer')).toBeVisible();
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

		// AI panel is hidden by default
		await expect(page.getByLabel('Show AI')).toBeVisible();

		await page.getByLabel('Show AI').click();

		await expect(page.getByText('AI Assistant')).toBeVisible();
	});

	test('snapshot toggle button is present', async ({ page }) => {
		await gotoIDE(page);

		// Snapshot panel is hidden by default
		await expect(page.getByLabel('Show snapshots')).toBeVisible();
	});

	test('clicking snapshot toggle shows the snapshot panel', async ({ page }) => {
		await gotoIDE(page);

		// Click the snapshot toggle
		await page.getByLabel('Show snapshots').click();

		// The snapshot panel header should appear with "Snapshots" text
		await expect(page.getByText('Snapshots', { exact: true })).toBeVisible({ timeout: 10_000 });
		// Empty state should show
		await expect(page.getByText('No snapshots yet')).toBeVisible();
	});

	test('snapshot panel close button hides it', async ({ page }) => {
		await gotoIDE(page);

		// Open snapshot panel
		await page.getByLabel('Show snapshots').click();
		await expect(page.getByText('Snapshots', { exact: true })).toBeVisible({ timeout: 10_000 });

		// Close it via the close button in the panel header
		await page.getByLabel('Close').click();

		// Panel should be gone
		await expect(page.getByText('No snapshots yet')).not.toBeVisible();
		// Toggle button should say "Show snapshots" again
		await expect(page.getByLabel('Show snapshots')).toBeVisible();
	});
});
