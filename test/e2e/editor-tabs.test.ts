/**
 * Editor Tabs E2E Tests
 *
 * Tests the file tab bar behavior:
 * - Opening files creates tabs
 * - Switching between tabs
 * - Closing tabs
 */

import { expect, test } from 'playwright/test';

import { gotoIDE, waitForFileTree } from './helpers';

test.describe('Editor Tabs', () => {
	test('opening a file creates a tab', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Click on index.html in the file tree
		await page.getByText('index.html').click();

		// Tab should appear
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();
	});

	test('opening multiple files creates multiple tabs', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Open index.html
		await page.getByText('index.html').click();
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();

		// Open tsconfig.json
		await page.getByText('tsconfig.json').click();
		await expect(page.getByRole('tab', { name: /tsconfig\.json/i })).toBeVisible();

		// Both tabs should be present (scope to the file tab bar, not the utility panel)
		const fileTabBar = page.getByRole('tablist').first();
		const tabs = fileTabBar.getByRole('tab');
		await expect(tabs).toHaveCount(2);
	});

	test('clicking a tab switches to that file', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Open two files
		await page.getByText('index.html').click();
		await page.getByText('tsconfig.json').click();

		// tsconfig.json should be active (last opened)
		const tsconfigTab = page.getByRole('tab', { name: /tsconfig\.json/i });
		await expect(tsconfigTab).toHaveAttribute('data-state', 'active');

		// Click on index.html tab to switch
		const indexTab = page.getByRole('tab', { name: /index\.html/i });
		await indexTab.click();

		// index.html tab should now be active
		await expect(indexTab).toHaveAttribute('data-state', 'active');

		// The terminal header shows the active file path
		await expect(page.getByText('/index.html')).toBeVisible();
	});

	test('closing a tab removes it', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Open a file
		await page.getByText('index.html').click();
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();

		// Close the tab via the close button
		const closeButton = page.getByRole('tab', { name: /index\.html/i }).getByLabel('Close');
		await closeButton.click();

		// Tab should be gone
		await expect(page.getByRole('tab', { name: /index\.html/i })).not.toBeVisible();

		// Should show empty editor placeholder again
		await expect(page.getByText('Select a file to edit')).toBeVisible();
	});
});
