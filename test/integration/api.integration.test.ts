import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

/** Cached session cookie for authenticated requests. */
let sessionCookie: string;

/** Track all project IDs created during tests for cleanup. */
const createdProjectIds: string[] = [];

/**
 * Create a test session via the dev-only endpoint and cache the cookie.
 * Retries on failure to handle transient CI startup issues.
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
			sessionCookie = setCookieHeader.split(';')[0];
			return sessionCookie;
		}

		if (attempt < maxRetries) {
			await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
			continue;
		}

		const body = await response.text().catch(() => '');
		throw new Error(`Failed to create test session after ${maxRetries} attempts: ${response.status} ${response.statusText} — ${body}`);
	}

	throw new Error('Unreachable');
}

/** Helper to make an authenticated fetch request. */
async function authedFetch(url: string, options: RequestInit = {}): Promise<Response> {
	const cookie = await ensureTestSession();
	const headers = new Headers(options.headers);
	headers.set('Cookie', cookie);
	return fetch(url, { ...options, headers });
}

/** Create a project and track its ID for cleanup. */
async function createTrackedProject(template = 'request-inspector'): Promise<{ projectId: string; url: string; name: string }> {
	const response = await authedFetch(`${BASE_URL}/api/new-project`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ template }),
	});
	const result: { projectId: string; url: string; name: string } = await response.json();
	if (result.projectId) createdProjectIds.push(result.projectId);
	return result;
}

/** Clean up all tracked test projects. */
async function cleanupProjects(): Promise<void> {
	const cookie = sessionCookie;
	if (!cookie) return;

	for (const projectId of createdProjectIds) {
		try {
			await fetch(`${BASE_URL}/api/org/project/${projectId}`, {
				method: 'DELETE',
				headers: { Cookie: cookie },
			});
		} catch {
			// Ignore — project may already be deleted
		}
	}
	createdProjectIds.length = 0;

	try {
		await fetch(`${BASE_URL}/__test/cleanup`, { method: 'POST' });
	} catch {
		// Ignore — server may be down
	}
}

/**
 * Integration tests for REST API endpoints.
 * These test the HTTP API directly against a running dev server.
 */
describe('REST API Integration Tests', () => {
	beforeAll(async () => {
		await ensureTestSession();
		// Clean up leftover projects from prior interrupted runs
		await cleanupProjects();
	});

	afterAll(async () => {
		await cleanupProjects();
	});
	describe('Health & Availability', () => {
		it('should serve the app root', async () => {
			const response = await fetch(`${BASE_URL}/`);
			expect(response.ok).toBe(true);
		});
	});

	describe('Templates API', () => {
		it('GET /api/templates returns available templates', async () => {
			const response = await fetch(`${BASE_URL}/api/templates`);
			expect(response.ok).toBe(true);

			const result: { templates: Array<{ id: string; name: string; description: string }> } = await response.json();
			expect(Array.isArray(result.templates)).toBe(true);
			expect(result.templates.length).toBeGreaterThan(0);

			for (const template of result.templates) {
				expect(template).toHaveProperty('id');
				expect(template).toHaveProperty('name');
				expect(template).toHaveProperty('description');
			}
		});
	});

	describe('Project Creation API', () => {
		it('POST /api/new-project creates a new project', async () => {
			const result = await createTrackedProject();
			expect(result).toHaveProperty('projectId');
			expect(result).toHaveProperty('url');
			expect(result).toHaveProperty('name');

			expect(result.projectId).toMatch(/^[a-z\d]{1,50}$/);
			// url should contain the projectId
			expect(result.url).toBe(`/p/${result.projectId}`);
			// name should be a human-readable ID
			expect(result.name).toBeTruthy();
		});

		it('POST /api/new-project with template creates project with specified template', async () => {
			// First get available templates
			const templatesResponse = await fetch(`${BASE_URL}/api/templates`);
			const { templates }: { templates: Array<{ id: string }> } = await templatesResponse.json();
			const templateId = templates[0].id;

			const result = await createTrackedProject(templateId);
			expect(result.projectId).toMatch(/^[a-z\d]{1,50}$/);
		});

		it('POST /api/new-project with invalid template returns 400', async () => {
			const response = await authedFetch(`${BASE_URL}/api/new-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ template: 'nonexistent-template-id' }),
			});

			expect(response.status).toBe(400);
			const result: { error: string } = await response.json();
			expect(result.error).toContain('Unknown template');
		});
	});

	describe('Project Clone API', () => {
		it('POST /api/clone-project clones an existing project', async () => {
			// Create a project first
			const { projectId: sourceProjectId } = await createTrackedProject();

			// Access the project to trigger initialization
			await authedFetch(`${BASE_URL}/p/${sourceProjectId}/api/files`);

			// Clone it
			const cloneResponse = await authedFetch(`${BASE_URL}/api/clone-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sourceProjectId }),
			});

			expect(cloneResponse.ok).toBe(true);
			const result: { projectId: string; url: string; name: string } = await cloneResponse.json();
			if (result.projectId) createdProjectIds.push(result.projectId);
			expect(result.projectId).toMatch(/^[a-z\d]{1,50}$/);
			expect(result.projectId).not.toBe(sourceProjectId);
			expect(result.url).toBe(`/p/${result.projectId}`);
		});

		it('POST /api/clone-project with invalid sourceProjectId returns 400', async () => {
			const response = await authedFetch(`${BASE_URL}/api/clone-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sourceProjectId: 'not-a-valid-id' }),
			});

			expect(response.status).toBe(400);
		});

		it('POST /api/clone-project without body returns 400', async () => {
			const response = await authedFetch(`${BASE_URL}/api/clone-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});

			expect(response.status).toBe(400);
		});
	});

	describe('Project File API', () => {
		let projectId: string;

		// Create a fresh project for file tests
		it('should create a project for file operations', async () => {
			const result = await createTrackedProject();
			projectId = result.projectId;
			expect(projectId).toBeTruthy();
		});

		it('GET /api/files returns the project file listing', async () => {
			const response = await authedFetch(`${BASE_URL}/p/${projectId}/api/files`);
			expect(response.ok).toBe(true);

			const result: { files: Array<{ path: string; name: string; isDirectory: boolean }> } = await response.json();
			expect(Array.isArray(result.files)).toBe(true);
			expect(result.files.length).toBeGreaterThan(0);

			for (const file of result.files) {
				expect(file).toHaveProperty('path');
				expect(file).toHaveProperty('name');
				expect(file).toHaveProperty('isDirectory');
			}
		});

		it('GET /api/file?path= returns file content', async () => {
			// Read the index.html which should exist from the template
			const response = await authedFetch(`${BASE_URL}/p/${projectId}/api/file?path=/index.html`);
			expect(response.ok).toBe(true);

			const result: { path: string; content: string } = await response.json();
			expect(typeof result.content).toBe('string');
			expect(result.content.length).toBeGreaterThan(0);
			expect(result.path).toBe('/index.html');
		});

		it('PUT /api/file creates or updates a file', async () => {
			const testContent = '// integration test file\nconsole.log("hello");\n';
			const response = await authedFetch(`${BASE_URL}/p/${projectId}/api/file`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/test-file.js', content: testContent }),
			});

			expect(response.ok).toBe(true);

			// Verify the file was written
			const readResponse = await authedFetch(`${BASE_URL}/p/${projectId}/api/file?path=/test-file.js`);
			const readResult: { content: string } = await readResponse.json();
			expect(readResult.content).toBe(testContent);
		});

		it('DELETE /api/file?path= deletes a file', async () => {
			// Create a file to delete
			await authedFetch(`${BASE_URL}/p/${projectId}/api/file`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/to-delete.txt', content: 'delete me' }),
			});

			const deleteResponse = await authedFetch(`${BASE_URL}/p/${projectId}/api/file?path=/to-delete.txt`, {
				method: 'DELETE',
			});

			expect(deleteResponse.ok).toBe(true);

			// Verify the file is gone
			const readResponse = await authedFetch(`${BASE_URL}/p/${projectId}/api/file?path=/to-delete.txt`);
			expect(readResponse.ok).toBe(false);
		});
	});
});
