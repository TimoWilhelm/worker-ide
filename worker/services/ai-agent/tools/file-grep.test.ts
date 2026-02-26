/**
 * Integration tests for the file_grep tool.
 *
 * Tests regex search, include filtering (real minimatch), binary skipping,
 * match grouping, and result capping against an in-memory filesystem.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const memoryFs = createMemoryFs();

vi.mock('node:fs/promises', () => memoryFs.asMock());

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./file-grep');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('file_grep', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Basic search ──────────────────────────────────────────────────────

	it('finds matches with line numbers grouped by file', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/app.ts`, 'import React from "react";\nconst App = () => {};\nexport default App;\n');
		memoryFs.seedFile(`${PROJECT_ROOT}/src/index.ts`, 'import App from "./app";\nReact.render(App);\n');

		const result = await execute({ pattern: 'App' }, createMockSendEvent(), context());

		expect(result.output).toContain('Found');
		expect(result.output).toContain('/src/app.ts');
		expect(result.output).toContain('Line');
	});

	it('supports regex patterns', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/code.ts`, 'function hello() {}\nfunction world() {}\nconst x = 1;\n');

		const result = await execute({ pattern: String.raw`function\s+\w+` }, createMockSendEvent(), context());

		expect(result.output).toContain('Found 2 matches');
		expect(result.output).toContain('function hello');
		expect(result.output).toContain('function world');
	});

	// ── Include filter ────────────────────────────────────────────────────

	it('filters files by include pattern', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/file.ts`, 'target\n');
		memoryFs.seedFile(`${PROJECT_ROOT}/file.js`, 'target\n');
		memoryFs.seedFile(`${PROJECT_ROOT}/file.css`, 'target\n');

		const result = await execute({ pattern: 'target', include: '*.ts' }, createMockSendEvent(), context());

		expect(result.output).toContain('Found 1 match');
		expect(result.output).toContain('file.ts');
		expect(result.output).not.toContain('file.js');
		expect(result.output).not.toContain('file.css');
	});

	// ── Subdirectory search ───────────────────────────────────────────────

	it('searches within a specific subdirectory', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/deep/file.ts`, 'needle\n');
		memoryFs.seedFile(`${PROJECT_ROOT}/other/file.ts`, 'needle\n');

		const result = await execute({ pattern: 'needle', path: '/src' }, createMockSendEvent(), context());

		expect(result.output).toContain('Found 1 match');
		expect(result.output).toContain('deep/file.ts');
		expect(result.output).not.toContain('other');
	});

	// ── Binary file skipping ──────────────────────────────────────────────

	it('skips binary files', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/image.png`, 'needle');
		memoryFs.seedFile(`${PROJECT_ROOT}/text.ts`, 'needle\n');

		const result = await execute({ pattern: 'needle' }, createMockSendEvent(), context());

		expect(result.output).toContain('Found 1 match');
		expect(result.output).not.toContain('image.png');
	});

	// ── No results ────────────────────────────────────────────────────────

	it('returns "No files found" when nothing matches', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/file.ts`, 'hello world\n');

		const result = await execute({ pattern: 'zzzznonexistent' }, createMockSendEvent(), context());

		expect(result.output).toBe('No files found');
	});

	// ── Invalid regex ─────────────────────────────────────────────────────

	it('returns INVALID_REGEX for bad patterns', async () => {
		await expect(execute({ pattern: '[invalid' }, createMockSendEvent(), context())).rejects.toThrow('[INVALID_REGEX]');
	});

	// ── Long line truncation ──────────────────────────────────────────────

	it('truncates matching lines longer than 2000 characters', async () => {
		const longLine = 'match' + 'x'.repeat(3000);
		memoryFs.seedFile(`${PROJECT_ROOT}/long.ts`, longLine + '\n');

		const result = await execute({ pattern: 'match' }, createMockSendEvent(), context());

		expect(result.output).toContain('...');
		expect(result.output).not.toContain('x'.repeat(3000));
	});

	// ── Case insensitive ──────────────────────────────────────────────────

	it('searches case-insensitively', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/file.ts`, 'Hello World\nhello world\nHELLO WORLD\n');

		const result = await execute({ pattern: 'hello' }, createMockSendEvent(), context());

		expect(result.output).toContain('Found 3 matches');
	});
});
