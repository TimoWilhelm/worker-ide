import { describe, expect, it } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

/**
 * Integration tests for REST API endpoints.
 * These test the HTTP API directly against a running dev server.
 */
describe('REST API Integration Tests', () => {
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
			const response = await fetch(`${BASE_URL}/api/new-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});

			expect(response.ok).toBe(true);

			const result: { projectId: string; url: string; name: string } = await response.json();
			expect(result).toHaveProperty('projectId');
			expect(result).toHaveProperty('url');
			expect(result).toHaveProperty('name');

			// projectId should be a 64-char hex string
			expect(result.projectId).toMatch(/^[a-f0-9]{64}$/i);
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

			const response = await fetch(`${BASE_URL}/api/new-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ template: templateId }),
			});

			expect(response.ok).toBe(true);
			const result: { projectId: string; url: string; name: string } = await response.json();
			expect(result.projectId).toMatch(/^[a-f0-9]{64}$/i);
		});

		it('POST /api/new-project with invalid template returns 400', async () => {
			const response = await fetch(`${BASE_URL}/api/new-project`, {
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
			const createResponse = await fetch(`${BASE_URL}/api/new-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			const { projectId: sourceProjectId }: { projectId: string } = await createResponse.json();

			// Access the project to trigger initialization
			await fetch(`${BASE_URL}/p/${sourceProjectId}/api/files`);

			// Clone it
			const cloneResponse = await fetch(`${BASE_URL}/api/clone-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sourceProjectId }),
			});

			expect(cloneResponse.ok).toBe(true);
			const result: { projectId: string; url: string; name: string } = await cloneResponse.json();
			expect(result.projectId).toMatch(/^[a-f0-9]{64}$/i);
			expect(result.projectId).not.toBe(sourceProjectId);
			expect(result.url).toBe(`/p/${result.projectId}`);
		});

		it('POST /api/clone-project with invalid sourceProjectId returns 400', async () => {
			const response = await fetch(`${BASE_URL}/api/clone-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sourceProjectId: 'not-a-valid-id' }),
			});

			expect(response.status).toBe(400);
		});

		it('POST /api/clone-project without body returns 400', async () => {
			const response = await fetch(`${BASE_URL}/api/clone-project`, {
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
			const response = await fetch(`${BASE_URL}/api/new-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			const result: { projectId: string } = await response.json();
			projectId = result.projectId;
			expect(projectId).toBeTruthy();
		});

		it('GET /api/files returns the project file listing', async () => {
			const response = await fetch(`${BASE_URL}/p/${projectId}/api/files`);
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
			const response = await fetch(`${BASE_URL}/p/${projectId}/api/file?path=/index.html`);
			expect(response.ok).toBe(true);

			const result: { path: string; content: string } = await response.json();
			expect(typeof result.content).toBe('string');
			expect(result.content.length).toBeGreaterThan(0);
			expect(result.path).toBe('/index.html');
		});

		it('PUT /api/file creates or updates a file', async () => {
			const testContent = '// integration test file\nconsole.log("hello");\n';
			const response = await fetch(`${BASE_URL}/p/${projectId}/api/file`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/test-file.js', content: testContent }),
			});

			expect(response.ok).toBe(true);

			// Verify the file was written
			const readResponse = await fetch(`${BASE_URL}/p/${projectId}/api/file?path=/test-file.js`);
			const readResult: { content: string } = await readResponse.json();
			expect(readResult.content).toBe(testContent);
		});

		it('DELETE /api/file?path= deletes a file', async () => {
			// Create a file to delete
			await fetch(`${BASE_URL}/p/${projectId}/api/file`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/to-delete.txt', content: 'delete me' }),
			});

			const deleteResponse = await fetch(`${BASE_URL}/p/${projectId}/api/file?path=/to-delete.txt`, {
				method: 'DELETE',
			});

			expect(deleteResponse.ok).toBe(true);

			// Verify the file is gone
			const readResponse = await fetch(`${BASE_URL}/p/${projectId}/api/file?path=/to-delete.txt`);
			expect(readResponse.ok).toBe(false);
		});
	});
});
