/**
 * E2E Test Helpers
 *
 * Shared utilities for testing the Worker IDE against the real
 * Cloudflare Worker dev server. Projects are created via the API,
 * giving us valid Durable Object IDs.
 *
 * Authentication uses the dev-only `/__test/create-session` endpoint
 * which seeds a test user/org/session in the local D1 and returns a
 * session cookie. This cookie is cached for the lifetime of the test run.
 */

import type { Page } from 'playwright/test';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

/** Cached session cookie string, e.g. "better-auth.session_token=...". Cached per worker process. */
let sessionCookie: string | undefined;

/**
 * Ensure a test session exists and return the session cookie.
 * Calls the dev-only `/__test/create-session` endpoint on first invocation
 * and caches the result for subsequent calls.
 */
async function ensureTestSession(): Promise<string> {
	if (sessionCookie) return sessionCookie;

	const maxRetries = 5;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const response = await fetch(`${BASE_URL}/__test/create-session`, {
			method: 'POST',
		});

		if (response.ok) {
			const setCookieHeader = response.headers.get('set-cookie');
			if (!setCookieHeader) {
				throw new Error('No session cookie returned from /__test/create-session');
			}
			// Extract just the name=value portion (before any ;)
			sessionCookie = setCookieHeader.split(';')[0];
			return sessionCookie;
		}

		if (attempt < maxRetries) {
			await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
			continue;
		}

		throw new Error(`Failed to create test session after ${maxRetries} attempts: ${response.status} ${response.statusText}`);
	}

	throw new Error('Unreachable');
}

/**
 * Create a new project via the API and return the project ID and URL.
 */
async function createProject(): Promise<{ projectId: string; url: string }> {
	const cookie = await ensureTestSession();

	const response = await fetch(`${BASE_URL}/api/new-project`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Cookie: cookie,
		},
		body: JSON.stringify({ template: 'request-inspector' }),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Failed to create project: ${response.status} ${response.statusText} — ${body}`);
	}

	const text = await response.text();
	const data: { projectId: string; url: string } = JSON.parse(text);
	return data;
}

/**
 * Navigate to a freshly created project in the IDE.
 * Creates a real project via the API so the Durable Object is valid.
 * Injects the test session cookie into the browser context so the
 * AuthGate passes, then clears localStorage to reset persisted Zustand
 * state (sidebar/terminal visibility, etc.) before the page loads.
 */
export async function gotoIDE(page: Page): Promise<string> {
	const cookie = await ensureTestSession();
	const { url, projectId } = await createProject();

	// Inject the session cookie into the browser context
	const separatorIndex = cookie.indexOf('=');
	const cookieName = cookie.slice(0, separatorIndex);
	const cookieValue = cookie.slice(separatorIndex + 1);
	const parsedUrl = new URL(BASE_URL);
	await page.context().addCookies([
		{
			name: cookieName,
			value: cookieValue,
			domain: parsedUrl.hostname,
			path: '/',
		},
	]);

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
