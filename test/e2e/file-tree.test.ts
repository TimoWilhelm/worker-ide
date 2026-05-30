import { expect, test } from 'playwright/test';

import { gotoIDE, waitForFileTree } from './helpers';

test.describe('File Tree', () => {
	test('displays files from the example project', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Root-level files from the example project
		await expect(page.getByRole('treeitem', { name: 'index.html' })).toBeVisible();
		await expect(page.getByRole('treeitem', { name: 'tsconfig.json' })).toBeVisible();
	});

	test('displays directory entries', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Scope to the file tree so log badges like "worker" in the output panel don't collide
		const fileTree = page.getByRole('tree');

		// Directories derived from example project file paths
		await expect(fileTree.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
		await expect(fileTree.getByRole('treeitem', { name: 'worker', exact: true })).toBeVisible();
	});

	test('can collapse and re-expand a directory', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Directories start expanded — child files should already be visible
		await expect(page.getByRole('treeitem', { name: 'main.tsx' })).toBeVisible();
		await expect(page.getByRole('treeitem', { name: 'app.tsx' })).toBeVisible();
		await expect(page.getByRole('treeitem', { name: 'style.css' })).toBeVisible();

		// Click on the "src" directory to collapse it
		const sourceDirectory = page.getByRole('treeitem', { name: 'src' });
		await sourceDirectory.click();

		// After collapse, child files should be hidden
		await expect(page.getByRole('treeitem', { name: 'main.tsx' })).not.toBeVisible();

		// Click again to re-expand
		await sourceDirectory.click();

		// Child files should be visible again
		await expect(page.getByRole('treeitem', { name: 'main.tsx' })).toBeVisible();
	});

	test('clicking a file opens it in the editor', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Click on a root-level file
		await page.getByRole('treeitem', { name: 'index.html' }).click();

		// The "Select a file to edit" placeholder should disappear
		await expect(page.getByText('Select a file to edit')).not.toBeVisible();

		// A tab should appear for the opened file
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();
	});

	test('selecting a file opens it as the active tab', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Click on index.html
		await page.getByRole('treeitem', { name: 'index.html' }).click();

		// The index.html tab should be selected
		await expect(page.getByRole('tab', { name: /index\.html/i })).toHaveAttribute('aria-selected', 'true');
	});
});
