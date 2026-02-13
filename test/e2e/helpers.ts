/**
 * E2E Test Helpers
 *
 * Shared utilities for testing the Worker IDE against the real
 * Cloudflare Worker dev server. Projects are created via the API,
 * giving us valid Durable Object IDs.
 */

import type { Page } from 'playwright/test';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

/**
 * Create a new project via the API and return the project ID and URL.
 */
export async function createProject(): Promise<{ projectId: string; url: string }> {
	const response = await fetch(`${BASE_URL}/api/new-project`, {
		method: 'POST',
	});

	if (!response.ok) {
		throw new Error(`Failed to create project: ${response.status} ${response.statusText}`);
	}

	const text = await response.text();
	const data: { projectId: string; url: string } = JSON.parse(text);
	return data;
}

/**
 * Navigate to a freshly created project in the IDE.
 * Creates a real project via the API so the Durable Object is valid.
 * Clears localStorage via addInitScript to reset persisted Zustand state
 * (sidebar/terminal visibility, etc.) before the page loads.
 */
export async function gotoIDE(page: Page): Promise<string> {
	const { url, projectId } = await createProject();

	// Clear localStorage before the app boots to reset persisted UI state
	await page.addInitScript(() => {
		localStorage.clear();
	});

	await page.goto(url);

	// Wait for the IDE to fully load — the header shows the project name
	// (a human-readable ID like "jade-crow-63") once IDEShell mounts
	await page.locator('h1').waitFor({ timeout: 15_000 });

	return projectId;
}

/**
 * Wait for the file tree to load by checking for the Explorer label
 * and at least one file entry.
 */
export async function waitForFileTree(page: Page): Promise<void> {
	await page.getByText('Files', { exact: true }).waitFor({ timeout: 10_000 });
	// The example project always has an index.html at root
	await page.getByText('index.html').waitFor({ timeout: 10_000 });
}
