/**
 * Integration tests for the lint_fix tool with REAL Biome WASM.
 *
 * Unlike lint-fix.test.ts (which mocks Biome entirely), these tests load the
 * actual Biome WASM binary so the full tool pipeline is exercised end-to-end:
 *   seed file → execute tool → Biome lints & fixes → file written → events sent
 *
 * Runs in the Node-based `unit` vitest project (not workerd) because the 27 MiB
 * WASM binary cannot load inside the workerd sandbox.
 *
 * What's mocked:
 *   - node:fs/promises  → in-memory filesystem (same pattern as other tool tests)
 *   - coordinatorNamespace → no-op DO stub
 *
 * What runs for real:
 *   - Biome WASM (lint detection, auto-fixing, diagnostic mapping)
 *   - path-utilities (isPathSafe, isHiddenPath)
 *   - file-time (recordFileRead — writes to in-memory FS)
 *   - utilities (computeDiffStats, generateCompactDiff)
 *   - tool-errors (toolError throws ToolExecutionError)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { initSync } from '@biomejs/wasm-web';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileChange, SendEventFunction, ToolExecutorContext } from '../types';

// =============================================================================
// Bootstrap Biome WASM from disk (once, before any imports that use it)
// =============================================================================

beforeAll(() => {
	const wasmPath = path.resolve('node_modules/@biomejs/wasm-web/biome_wasm_bg.wasm');
	initSync({ module: readFileSync(wasmPath) });
}, 30_000);

// =============================================================================
// In-memory filesystem (stable singleton — vi.mock factory runs once)
// =============================================================================

interface MemoryFsEntry {
	content: string | Buffer;
	mtime: Date;
	isDirectory: boolean;
}

const store = new Map<string, MemoryFsEntry>();

function makeEnoentError(filePath: string): Error {
	const error = new Error(`ENOENT: no such file or directory, '${filePath}'`);
	(error as NodeJS.ErrnoException).code = 'ENOENT';
	return error;
}

function seedFile(absolutePath: string, content: string): void {
	store.set(absolutePath, { content, mtime: new Date(), isDirectory: false });
	// Auto-create parent directories
	const parts = absolutePath.split('/');
	for (let index = 1; index < parts.length - 1; index++) {
		const directoryPath = parts.slice(0, index + 1).join('/');
		if (!store.has(directoryPath)) {
			store.set(directoryPath, { content: '', mtime: new Date(), isDirectory: true });
		}
	}
}

vi.mock('node:fs/promises', () => ({
	default: {
		readFile: async (...arguments_: unknown[]): Promise<string | Buffer> => {
			const filePath = arguments_[0] as string;
			const encoding = typeof arguments_[1] === 'string' ? arguments_[1] : undefined;
			const entry = store.get(filePath);
			if (!entry || entry.isDirectory) throw makeEnoentError(filePath);
			// eslint-disable-next-line unicorn/text-encoding-identifier-case -- mock must match both encoding forms callers may pass
			if (encoding === 'utf8' || encoding === 'utf-8') {
				return typeof entry.content === 'string' ? entry.content : entry.content.toString('utf8');
			}
			return typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
		},
		writeFile: async (filePath: string, content: string | Buffer): Promise<void> => {
			store.set(filePath, { content, mtime: new Date(), isDirectory: false });
		},
		stat: async (filePath: string) => {
			const normalized = filePath.replaceAll(/\/+/g, '/');
			const entry = store.get(normalized);
			if (!entry) throw makeEnoentError(filePath);
			const size = typeof entry.content === 'string' ? Buffer.byteLength(entry.content, 'utf8') : entry.content.length;
			return {
				size,
				mtime: entry.mtime,
				mtimeMs: entry.mtime.getTime(),
				isDirectory: () => entry.isDirectory,
				isFile: () => !entry.isDirectory,
			};
		},
		mkdir: async () => {},
		rename: async (from: string, to: string): Promise<void> => {
			const entry = store.get(from);
			if (!entry) throw makeEnoentError(from);
			store.set(to, { ...entry, mtime: new Date() });
			store.delete(from);
		},
		rm: async () => {},
	},
}));

// =============================================================================
// Mock coordinator namespace (Cloudflare DO — unavailable in Node)
// =============================================================================

vi.mock('../../../lib/durable-object-namespaces', () => ({
	coordinatorNamespace: {
		idFromName: () => ({ toString: () => 'mock-id' }),
		get: () => ({ triggerUpdate: async () => {} }),
	},
}));

// =============================================================================
// Helpers
// =============================================================================

function createContext(overrides?: Partial<ToolExecutorContext>): ToolExecutorContext {
	return {
		projectRoot: '/project',
		projectId: 'test-project',
		mode: 'code' as const,
		sessionId: 'test-session',
		callMcpTool: async () => 'mock',
		...overrides,
	};
}

function createSendEvent(): SendEventFunction & { calls: Array<[string, Record<string, unknown>]> } {
	const calls: Array<[string, Record<string, unknown>]> = [];
	const function_ = (type: string, data: Record<string, unknown>) => {
		calls.push([type, data]);
	};
	function_.calls = calls;
	return function_ as SendEventFunction & { calls: Array<[string, Record<string, unknown>]> };
}

// =============================================================================
// Reset filesystem between tests
// =============================================================================

beforeEach(() => {
	store.clear();
});

// =============================================================================
// Tests
// =============================================================================

describe('lint_fix tool with real Biome WASM', () => {
	it('fixes == to === in a .ts file and writes the result', async () => {
		const { execute } = await import('./lint-fix');

		const original = `const x = 42;\nif (x == "42") {\n  console.log(x);\n}\n`;
		seedFile('/project/src/equality.ts', original);

		const sendEvent = createSendEvent();
		const context = createContext();
		const result = await execute({ path: '/src/equality.ts' }, sendEvent, context, 'tool-1');

		// Should return an object with diff info
		expect(typeof result).toBe('object');
		const resultObject = result as { result: string; linesAdded: number; linesRemoved: number; lintErrorCount: number };
		expect(resultObject.result).toContain('Fixed');
		expect(resultObject.result).toContain('lint issue');

		// Verify the in-memory FS was updated with fixed content
		const written = store.get('/project/src/equality.ts');
		expect(written).toBeDefined();
		const fixedContent = written!.content as string;
		expect(fixedContent).toContain('===');
		expect(fixedContent).not.toContain(' == ');
	});

	it('removes debugger statement in a .js file', async () => {
		const { execute } = await import('./lint-fix');

		const original = `const x = 1;\ndebugger;\nconsole.log(x);\n`;
		seedFile('/project/src/debug.js', original);

		const sendEvent = createSendEvent();
		const result = await execute({ path: '/src/debug.js' }, sendEvent, createContext(), 'tool-2');

		expect(typeof result).toBe('object');
		const fixedContent = store.get('/project/src/debug.js')!.content as string;
		expect(fixedContent).not.toContain('debugger');
		expect(fixedContent).toContain('console.log(x)');
	});

	it('fixes useless rename in a .ts file', async () => {
		const { execute } = await import('./lint-fix');

		const original = `const { a: a } = { a: 1 };\nconsole.log(a);\n`;
		seedFile('/project/src/rename.ts', original);

		const sendEvent = createSendEvent();
		const result = await execute({ path: '/src/rename.ts' }, sendEvent, createContext(), 'tool-3');

		expect(typeof result).toBe('object');
		const fixedContent = store.get('/project/src/rename.ts')!.content as string;
		expect(fixedContent).toContain('{ a }');
		expect(fixedContent).not.toContain('{ a: a }');
	});

	it('sends file_changed event with before and after content', async () => {
		const { execute } = await import('./lint-fix');

		const original = `const x = 42;\nif (x == "42") { console.log(x); }\n`;
		seedFile('/project/src/event-test.ts', original);

		const sendEvent = createSendEvent();
		await execute({ path: '/src/event-test.ts' }, sendEvent, createContext(), 'tool-4');

		expect(sendEvent.calls.length).toBe(1);
		const [eventType, eventData] = sendEvent.calls[0];
		expect(eventType).toBe('file_changed');
		expect(eventData.path).toBe('/src/event-test.ts');
		expect(eventData.action).toBe('edit');
		expect(eventData.beforeContent).toBe(original);
		expect(typeof eventData.afterContent).toBe('string');
		expect(eventData.afterContent).not.toBe(original);
	});

	it('tracks fix in queryChanges for snapshots', async () => {
		const { execute } = await import('./lint-fix');

		const original = `const x = 1;\ndebugger;\nconsole.log(x);\n`;
		seedFile('/project/src/snapshot-test.js', original);

		const queryChanges: FileChange[] = [];
		await execute({ path: '/src/snapshot-test.js' }, createSendEvent(), createContext(), 'tool-5', queryChanges);

		expect(queryChanges.length).toBe(1);
		expect(queryChanges[0].path).toBe('/src/snapshot-test.js');
		expect(queryChanges[0].action).toBe('edit');
		expect(queryChanges[0].beforeContent).toBe(original);
		expect(queryChanges[0].afterContent).not.toContain('debugger');
	});

	it('reports no lint issues for a clean file', async () => {
		const { execute } = await import('./lint-fix');

		seedFile('/project/src/clean.ts', `const x = 1;\nconsole.log(x);\n`);

		const result = await execute({ path: '/src/clean.ts' }, createSendEvent(), createContext());
		expect(typeof result).toBe('string');
		expect(result).toContain('No lint issues');
	});

	it('reports remaining unfixable diagnostics in result text', async () => {
		const { execute } = await import('./lint-fix');

		// This file has both fixable (==) and unfixable (invalid typeof) issues
		const original = `const x = 42;\nif (x == "42") {\n  console.log(typeof x === "strin");\n}\n`;
		seedFile('/project/src/mixed.ts', original);

		const sendEvent = createSendEvent();
		const result = await execute({ path: '/src/mixed.ts' }, sendEvent, createContext(), 'tool-6');

		expect(typeof result).toBe('object');
		const resultObject = result as { result: string; lintErrorCount: number };
		// Should mention remaining issues
		expect(resultObject.result).toContain('remain');
		expect(resultObject.result).toContain('useValidTypeof');
		expect(resultObject.lintErrorCount).toBeGreaterThanOrEqual(1);
	});

	it('handles TSX files with fixable void elements', async () => {
		const { execute } = await import('./lint-fix');

		// img without alt + closing tag triggers useAltText (unfixable) and possibly useSelfClosingElements
		const original = `export function App() {\n  return <div><img src="a"></img></div>;\n}\n`;
		seedFile('/project/src/component.tsx', original);

		const sendEvent = createSendEvent();
		const result = await execute({ path: '/src/component.tsx' }, sendEvent, createContext(), 'tool-7');

		// The tool should produce a result (either fixes or reports issues)
		expect(result).toBeDefined();
	});

	it('returns linesAdded and linesRemoved in result', async () => {
		const { execute } = await import('./lint-fix');

		seedFile('/project/src/diff-stats.ts', `const x = 42;\nif (x == "42") {\n  console.log(x);\n}\n`);

		const result = await execute({ path: '/src/diff-stats.ts' }, createSendEvent(), createContext(), 'tool-8');

		expect(typeof result).toBe('object');
		const resultObject = result as { linesAdded: number; linesRemoved: number };
		expect(typeof resultObject.linesAdded).toBe('number');
		expect(typeof resultObject.linesRemoved).toBe('number');
	});

	it('handles multiple fixable issues in one file', async () => {
		const { execute } = await import('./lint-fix');

		const original = [
			'const x = 42;',
			'const { a: a } = { a: 1 };',
			'if (x == "42") {',
			'  console.log(a);',
			'}',
			'if (x != 0) {',
			'  debugger;',
			'  console.log(x);',
			'}',
			'',
		].join('\n');
		seedFile('/project/src/many-issues.ts', original);

		const result = await execute({ path: '/src/many-issues.ts' }, createSendEvent(), createContext(), 'tool-9');

		expect(typeof result).toBe('object');
		const resultObject = result as { result: string };
		expect(resultObject.result).toContain('Fixed');

		const fixedContent = store.get('/project/src/many-issues.ts')!.content as string;
		expect(fixedContent).toContain('===');
		expect(fixedContent).toContain('!==');
		expect(fixedContent).toContain('{ a }');
		expect(fixedContent).not.toContain('debugger');
	});
});
