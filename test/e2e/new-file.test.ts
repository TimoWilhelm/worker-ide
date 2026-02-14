/**
 * New File E2E Tests
 *
 * Tests creating a new file via the sidebar "New File" button,
 * verifying it appears in the file tree and opens in the editor.
 */

import { expect, test } from 'playwright/test';

import { gotoIDE, waitForFileTree } from './helpers';

test.describe('New File', () => {
	test('new file button opens the new file dialog', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Click the "New file" button in the sidebar header
		const newFileButton = page.getByLabel('New file');
		await expect(newFileButton).toBeVisible();
		await newFileButton.click();

		// A dialog should appear asking for the file name
		await expect(page.getByText('New File')).toBeVisible();
	});

	test('creating a file adds it to the tree and opens it', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Open new file dialog
		await page.getByLabel('New file').click();
		await expect(page.getByText('New File')).toBeVisible();

		// Type a file name and submit
		const input = page.getByPlaceholder('e.g. src/utils.ts');
		await input.fill('hello.txt');
		await page.getByRole('button', { name: 'Create' }).click();

		// File should appear in the tree
		await expect(page.getByText('hello.txt')).toBeVisible();

		// A tab should open for the new file
		await expect(page.getByRole('tab', { name: /hello\.txt/i })).toBeVisible();
	});
});
