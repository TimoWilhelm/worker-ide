/**
 * Integration tests for the file_read tool.
 *
 * Tests real path validation, binary detection, line numbering, pagination,
 * and directory listing against an in-memory filesystem.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that touches fs
// ---------------------------------------------------------------------------

const memoryFs = createMemoryFs();

vi.mock('node:fs/promises', () => memoryFs.asMock());

// Biome linter — return empty diagnostics by default (overridable per-test)
const lintMock = vi.hoisted(() => ({
	diagnostics: [] as Array<{ line: number; column: number; rule: string; message: string; severity: string; fixable: boolean }>,
}));

vi.mock('../lib/biome-linter', () => ({
	lintFileForAgent: async () => lintMock.diagnostics,
	formatLintDiagnostics: (diagnostics: Array<{ severity: string; line: number; column: number; message: string; fixable: boolean }>) => {
		if (diagnostics.length === 0) return;
		return `Lint diagnostics (${diagnostics.length} issue(s)):\n${diagnostics.map((d) => `${d.severity === 'error' ? 'Error' : 'Warning'} [${d.line}:${d.column}] ${d.message}${d.fixable ? ' [auto-fixable]' : ''}`).join('\n')}`;
	},
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { execute } = await import('./file-read');

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

describe('file_read', () => {
	beforeEach(() => {
		memoryFs.reset();
		lintMock.diagnostics = [];
	});

	// ── Text file reading ─────────────────────────────────────────────────

	it('reads a text file with numbered lines', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/main.ts`, 'const x = 1;\nconst y = 2;\nconst z = 3;\n');

		const result = await execute({ path: '/src/main.ts' }, createMockSendEvent(), context());

		expect(result.output).toContain('<path>/src/main.ts</path>');
		expect(result.output).toContain('<type>file</type>');
		expect(result.output).toContain('1: const x = 1;');
		expect(result.output).toContain('2: const y = 2;');
		expect(result.output).toContain('3: const z = 3;');
		expect(result.output).toContain('End of file');
	});

	it('reads a file with offset and limit', async () => {
		const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
		memoryFs.seedFile(`${PROJECT_ROOT}/big.txt`, lines);

		const result = await execute({ path: '/big.txt', offset: '5', limit: '3' }, createMockSendEvent(), context());

		expect(result.output).toContain('5: line 5');
		expect(result.output).toContain('6: line 6');
		expect(result.output).toContain('7: line 7');
		expect(result.output).not.toContain('4: line 4');
		expect(result.output).not.toContain('8: line 8');
		expect(result.output).toContain('Use offset=8 to continue reading');
	});

	it('truncates long lines at 2000 characters', async () => {
		const longLine = 'x'.repeat(3000);
		memoryFs.seedFile(`${PROJECT_ROOT}/long.txt`, longLine);

		const result = await execute({ path: '/long.txt' }, createMockSendEvent(), context());

		expect(result.output).toContain('line truncated to 2000 chars');
		expect(result.output).not.toContain('x'.repeat(3000));
	});

	it('respects the 50KB output byte limit', async () => {
		// Each line ~100 bytes, need >512 lines to exceed 50KB
		const lines = Array.from({ length: 600 }, (_, index) => `${'a'.repeat(90)} line-${index + 1}`).join('\n');
		memoryFs.seedFile(`${PROJECT_ROOT}/huge.txt`, lines);

		const result = await execute({ path: '/huge.txt' }, createMockSendEvent(), context());

		expect(result.output).toContain('Output truncated due to size limit');
	});

	// ── Directory reading ─────────────────────────────────────────────────

	it('lists directory contents sorted with directories first', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/app.ts`, 'app');
		memoryFs.seedFile(`${PROJECT_ROOT}/src/utils/helper.ts`, 'helper');
		memoryFs.seedFile(`${PROJECT_ROOT}/src/index.ts`, 'index');

		const result = await execute({ path: '/src' }, createMockSendEvent(), context());

		expect(result.output).toContain('<type>directory</type>');
		expect(result.output).toContain('utils/');
		expect(result.output).toContain('app.ts');
		expect(result.output).toContain('index.ts');
		// Directories should appear before files
		const utilitiesIndex = result.output.indexOf('utils/');
		const appIndex = result.output.indexOf('app.ts');
		expect(utilitiesIndex).toBeLessThan(appIndex);
	});

	it('filters hidden entries from directory listing', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/.agent/config.json`, '{}');
		memoryFs.seedFile(`${PROJECT_ROOT}/src/main.ts`, 'main');
		memoryFs.seedFile(`${PROJECT_ROOT}/.initialized`, '1');

		const result = await execute({ path: '/' }, createMockSendEvent(), context());

		expect(result.output).toContain('src/');
		expect(result.output).not.toContain('.agent');
		expect(result.output).not.toContain('.initialized');
	});

	// ── Binary file detection ─────────────────────────────────────────────

	it('detects binary file by extension', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/image.png`, 'binary-data');

		const result = await execute({ path: '/image.png' }, createMockSendEvent(), context());

		expect(result.output).toContain('<type>binary</type>');
		expect(result.output).toContain('Binary file detected');
	});

	it('detects binary content with null bytes', async () => {
		const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
		memoryFs.seedFile(`${PROJECT_ROOT}/data.custom`, binaryContent);

		const result = await execute({ path: '/data.custom' }, createMockSendEvent(), context());

		expect(result.output).toContain('<type>binary</type>');
	});

	// ── Error cases ───────────────────────────────────────────────────────

	it('returns FILE_NOT_FOUND for missing file', async () => {
		await expect(execute({ path: '/nonexistent.ts' }, createMockSendEvent(), context())).rejects.toThrow('[FILE_NOT_FOUND]');
	});

	it('suggests similar files when file is not found', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/src/main.ts`, 'content');

		await expect(execute({ path: '/src/main.tsx' }, createMockSendEvent(), context())).rejects.toThrow('[FILE_NOT_FOUND]');
	});

	it('rejects path traversal with ..', async () => {
		await expect(execute({ path: '/../etc/passwd' }, createMockSendEvent(), context())).rejects.toThrow('[INVALID_PATH]');
	});

	it('rejects relative path without leading slash', async () => {
		await expect(execute({ path: 'src/main.ts' }, createMockSendEvent(), context())).rejects.toThrow('[INVALID_PATH]');
	});

	it('rejects hidden paths', async () => {
		await expect(execute({ path: '/.agent/config.json' }, createMockSendEvent(), context())).rejects.toThrow('[INVALID_PATH]');
	});

	// ── Diagnostics ──────────────────────────────────────────────────────

	it('includes diagnostics in metadata and output', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/lint.ts`, 'var x = 1;\n');
		lintMock.diagnostics = [
			{ line: 1, column: 1, rule: 'lint/style/noVar', message: 'Use const or let', severity: 'error', fixable: true },
		];

		const result = await execute({ path: '/lint.ts' }, createMockSendEvent(), context());

		expect(result.metadata.diagnostics).toHaveLength(1);
		expect(result.metadata.diagnostics[0]).toHaveProperty('rule', 'lint/style/noVar');
		expect(result.output).toContain('<lint_diagnostics>');
		expect(result.output).toContain('Use const or let');
		expect(result.output).toContain('</lint_diagnostics>');
	});

	it('caps diagnostics at MAX_DIAGNOSTICS_PER_FILE (20)', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/many-issues.ts`, 'content\n');
		lintMock.diagnostics = Array.from({ length: 25 }, (_, index) => ({
			line: index + 1,
			column: 1,
			rule: 'lint/style/noVar',
			message: `Issue ${index + 1}`,
			severity: 'error' as const,
			fixable: false,
		}));

		const result = await execute({ path: '/many-issues.ts' }, createMockSendEvent(), context());

		expect(result.metadata.diagnostics).toHaveLength(20);
		expect(result.output).toContain('Showing 20 of 25 diagnostics');
	});

	it('returns empty diagnostics array for clean files', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/clean.ts`, 'const x = 1;\n');

		const result = await execute({ path: '/clean.ts' }, createMockSendEvent(), context());

		expect(result.metadata.diagnostics).toEqual([]);
		expect(result.output).not.toContain('<lint_diagnostics>');
	});

	// ── Status events ─────────────────────────────────────────────────────

	it('sends a status event before reading', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/test.txt`, 'hello');
		const sendEvent = createMockSendEvent();

		await execute({ path: '/test.txt' }, sendEvent, context());

		expect(sendEvent.calls.length).toBeGreaterThanOrEqual(1);
		expect(sendEvent.calls[0][0]).toBe('status');
		expect(sendEvent.calls[0][1]).toHaveProperty('message');
	});
});
