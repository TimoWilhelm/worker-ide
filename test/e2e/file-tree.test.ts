/**
 * File Tree E2E Tests
 *
 * Tests interaction with the sidebar file tree using the real
 * example project files created by the backend.
 */

import { expect, test } from 'playwright/test';

import { gotoIDE, waitForFileTree } from './helpers';

test.describe('File Tree', () => {
	test('displays files from the example project', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Root-level files from the example project
		await expect(page.getByText('index.html')).toBeVisible();
		await expect(page.getByText('tsconfig.json')).toBeVisible();
	});

	test('displays directory entries', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Directories derived from example project file paths
		await expect(page.getByText('src', { exact: true })).toBeVisible();
		await expect(page.getByText('worker', { exact: true })).toBeVisible();
	});

	test('can collapse and re-expand a directory', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Directories start expanded — child files should already be visible
		await expect(page.getByText('main.ts')).toBeVisible();
		await expect(page.getByText('api.ts')).toBeVisible();
		await expect(page.getByText('style.css')).toBeVisible();

		// Click on the "src" directory to collapse it
		const sourceDirectory = page.getByText('src', { exact: true });
		await sourceDirectory.click();

		// After collapse, child files should be hidden
		await expect(page.getByText('main.ts')).not.toBeVisible();

		// Click again to re-expand
		await sourceDirectory.click();

		// Child files should be visible again
		await expect(page.getByText('main.ts')).toBeVisible();
	});

	test('clicking a file opens it in the editor', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Click on a root-level file
		await page.getByText('index.html').click();

		// The "Select a file to edit" placeholder should disappear
		await expect(page.getByText('Select a file to edit')).not.toBeVisible();

		// A tab should appear for the opened file
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();
	});

	test('selecting a file shows its path in the status bar', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Click on index.html
		await page.getByText('index.html').click();

		// Status bar (footer) should show the file path
		const footer = page.locator('footer');
		await expect(footer).toContainText('index.html');
	});
});
