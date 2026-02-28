/**
 * Test runner routes.
 * Handles running tests and discovering test files.
 *
 * Test results are stateless on the server — they are returned directly to the
 * caller and broadcast to collaborators via WebSocket. Each client stores
 * results in its own React Query cache.
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { HIDDEN_ENTRIES } from '@shared/constants/file-system';
import { ToolExecutionError } from '@shared/tool-errors';
import { testRunRequestSchema } from '@shared/validation';

import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import { runTests } from '../services/ai-agent/tools/test-run';

import type { AppEnvironment } from '../types';
import type { DiscoveredTest, DiscoveredTestFile } from '@shared/types';

const TEST_FILE_PATTERN = /\.(test|spec)\.[jt]sx?$/;

/**
 * Parse test file source to extract describe/it/test names.
 * Uses simple regex matching — not a full AST parse, but sufficient
 * for standard test patterns like:
 *   describe('suite', () => { it('test', ...) })
 *   test('standalone', ...)
 */
export function parseTestNames(source: string): DiscoveredTest[] {
	const tests: DiscoveredTest[] = [];

	// Match describe blocks: describe('name', ...)  or  describe("name", ...)  or  describe(`name`, ...)
	const describePattern = /\bdescribe\s*\(\s*(['"`])(.+?)\1/g;
	// Match it/test calls: it('name', ...)  or  test('name', ...)
	const testPattern = /\b(?:it|test)\s*\(\s*(['"`])(.+?)\1/g;

	// First, find all describe blocks and their positions
	const describes: Array<{ name: string; start: number }> = [];
	let describeMatch;
	while ((describeMatch = describePattern.exec(source)) !== undefined) {
		if (!describeMatch) break;
		describes.push({ name: describeMatch[2], start: describeMatch.index });
	}

	// For each it/test call, find which describe block it's inside (if any)
	let testMatch;
	while ((testMatch = testPattern.exec(source)) !== undefined) {
		if (!testMatch) break;
		const position = testMatch.index;

		// Find the nearest describe block that starts before this test
		// (simple heuristic — works for non-nested describes)
		let suiteName = '(top-level)';
		for (const describe of describes) {
			if (describe.start < position) {
				suiteName = describe.name;
			}
		}

		// Compute 1-based line number from character offset
		let line = 1;
		for (let index = 0; index < position; index++) {
			if (source[index] === '\n') line++;
		}

		tests.push({ name: testMatch[2], suiteName, line });
	}

	return tests;
}

/**
 * Test routes - all routes are prefixed with /api
 * These routes are chained for Hono RPC type inference.
 */
export const testRoutes = new Hono<AppEnvironment>()
	// POST /api/test/run - Run tests and broadcast results
	.post('/test/run', zValidator('json', testRunRequestSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { pattern, testName } = c.req.valid('json');

		try {
			const result = await runTests(projectRoot, pattern, undefined, testName);

			const testResponse = {
				title: result.title,
				output: result.output,
				metadata: result.metadata,
				fileResults: result.fileResults,
				bundleErrors: result.bundleErrors,
				timestamp: Date.now(),
			};

			// Broadcast results to all connected clients so collaborators
			// can update their local state. Each client handles merge logic
			// for single-test runs locally.
			try {
				const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
				const coordinatorStub = coordinatorNamespace.get(coordinatorId);
				await coordinatorStub.sendMessage({
					type: 'test-results-changed',
					results: testResponse,
					testName,
					pattern,
				});
			} catch {
				// Non-critical — caller still gets results directly
			}

			return c.json(testResponse);
		} catch (error) {
			if (error instanceof ToolExecutionError) {
				if (error.code === 'FILE_NOT_FOUND') {
					throw httpError(404, error.message);
				}
				throw httpError(400, error.message);
			}
			const message = error instanceof Error ? error.message : 'Test run failed';
			throw httpError(500, message);
		}
	})

	// GET /api/test/discover - Parse test files to discover test names without running them
	.get('/test/discover', async (c) => {
		const projectRoot = c.get('projectRoot');

		// Discover all test files by walking the project
		const testFiles = await discoverTestFilePaths(projectRoot);

		// Parse each file for describe/it/test names
		const discoveredFiles: DiscoveredTestFile[] = [];
		for (const filePath of testFiles) {
			try {
				const content = await fs.readFile(`${projectRoot}/${filePath}`, 'utf8');
				const tests = parseTestNames(content);
				discoveredFiles.push({ file: filePath, tests });
			} catch {
				// Skip files that can't be read
			}
		}

		return c.json({ files: discoveredFiles });
	});

/**
 * Walk the project filesystem to find test files (*.test.* / *.spec.*).
 * Returns relative paths without leading slash.
 */
async function discoverTestFilePaths(projectRoot: string, base = ''): Promise<string[]> {
	const results: string[] = [];
	try {
		const entries = await fs.readdir(`${projectRoot}${base ? `/${base}` : ''}`, { withFileTypes: true });
		for (const entry of entries) {
			if (HIDDEN_ENTRIES.has(entry.name)) continue;

			const relativePath = base ? `${base}/${entry.name}` : entry.name;

			if (entry.isDirectory()) {
				const nested = await discoverTestFilePaths(projectRoot, relativePath);
				results.push(...nested);
			} else if (TEST_FILE_PATTERN.test(entry.name)) {
				results.push(relativePath);
			}
		}
	} catch {
		// Directory not readable — skip
	}
	return results;
}
