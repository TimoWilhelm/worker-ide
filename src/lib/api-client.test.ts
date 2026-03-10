/**
 * Unit tests for project management functions in the API client.
 *
 * Tests createProject() and cloneProject() which use raw fetch
 * against root-level endpoints (outside the Hono RPC client).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cloneProject, createProject, fetchTemplates } from './api-client';

// =============================================================================
// Mocks
// =============================================================================

const fetchMock = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Helper to create a mock Response with JSON body.
 */
function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

// =============================================================================
// createProject
// =============================================================================

describe('createProject', () => {
	it('creates a project with a template', async () => {
		const responseData = { projectId: 'abc123', url: '/p/abc123', name: 'gentle-wave' };
		fetchMock.mockResolvedValueOnce(jsonResponse(responseData));

		const result = await createProject('request-inspector');

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith('/api/new-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ template: 'request-inspector' }),
		});
		expect(result).toEqual(responseData);
	});

	it('throws on non-OK response', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Bad request' }, 400));

		await expect(createProject('request-inspector')).rejects.toThrow('Bad request');
	});

	it('throws on network error', async () => {
		fetchMock.mockRejectedValueOnce(new Error('Network error'));

		await expect(createProject('request-inspector')).rejects.toThrow('Network error');
	});
});

// =============================================================================
// cloneProject
// =============================================================================

describe('cloneProject', () => {
	const sourceId = 'a'.repeat(64);

	it('clones a project successfully', async () => {
		const responseData = { projectId: 'new123', url: '/p/new123', name: 'cloned-project' };
		fetchMock.mockResolvedValueOnce(jsonResponse(responseData));

		const result = await cloneProject(sourceId);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/clone-project',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ sourceProjectId: sourceId }),
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		expect(result).toEqual(responseData);
	});

	it('throws on 404', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Source project not found or not initialized' }, 404));

		await expect(cloneProject(sourceId)).rejects.toThrow('Source project not found or not initialized');
	});

	it('throws on 400', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Invalid source project ID. Must be a 64-character hex string.' }, 400));

		await expect(cloneProject(sourceId)).rejects.toThrow('Invalid source project ID');
	});

	it('throws on 500 with non-JSON body', async () => {
		fetchMock.mockResolvedValueOnce(new Response('not json', { status: 500 }));

		await expect(cloneProject(sourceId)).rejects.toThrow('Failed to clone project');
	});

	it('throws on network error', async () => {
		fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

		await expect(cloneProject(sourceId)).rejects.toThrow('Connection refused');
	});
});

// =============================================================================
// fetchTemplates
// =============================================================================

describe('fetchTemplates', () => {
	it('fetches templates successfully', async () => {
		const templatesData = [
			{
				id: 'request-inspector',
				name: 'Request Inspector',
				description: 'Inspect HTTP headers.',
				icon: 'Search',
			},
		];
		fetchMock.mockResolvedValueOnce(jsonResponse({ templates: templatesData }));

		const result = await fetchTemplates();

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith('/api/templates');
		expect(result).toEqual(templatesData);
	});

	it('throws on non-OK response', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Server error' }, 500));

		await expect(fetchTemplates()).rejects.toThrow('Server error');
	});

	it('throws on network error', async () => {
		fetchMock.mockRejectedValueOnce(new Error('Network error'));

		await expect(fetchTemplates()).rejects.toThrow('Network error');
	});
});
