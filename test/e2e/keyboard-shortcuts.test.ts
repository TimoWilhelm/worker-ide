/**
 * Keyboard Shortcuts E2E Tests
 *
 * Tests keyboard shortcut handling in the IDE.
 */

import { expect, test } from 'playwright/test';

import { gotoIDE, waitForFileTree } from './helpers';

test.describe('Keyboard Shortcuts', () => {
	test('Ctrl+S triggers save (no error when no file is open)', async ({ page }) => {
		await gotoIDE(page);

		// No file is open, so Ctrl+S should be a no-op (no crash)
		await page.keyboard.press('Control+s');

		// App should still be functional
		await expect(page.getByText('Worker IDE')).toBeVisible();
	});

	test('Ctrl+S with a file open does not cause errors', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Open a file
		await page.getByText('index.html').click();
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();

		// Press Ctrl+S — should trigger save without crashing
		await page.keyboard.press('Control+s');

		// App should still be functional
		await expect(page.getByRole('heading', { name: 'Worker IDE' })).toBeVisible();
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();
	});
});
