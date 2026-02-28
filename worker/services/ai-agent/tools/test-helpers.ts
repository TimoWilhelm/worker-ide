/**
 * Shared test helpers for AI tool integration tests.
 *
 * Provides an in-memory filesystem that backs the `node:fs/promises` mock,
 * so tools exercise real read → write → edit flows against a consistent store.
 */

import type { SendEventFunction, ToolExecutorContext } from '../types';

// =============================================================================
// In-Memory Filesystem
// =============================================================================

interface MemoryFsEntry {
	content: string | Buffer;
	mtime: Date;
	isDirectory: boolean;
}

export interface MemoryFs {
	/** The underlying store — keyed by absolute path */
	store: Map<string, MemoryFsEntry>;

	/** Seed a file into the virtual filesystem */
	seedFile: (absolutePath: string, content: string | Buffer) => void;

	/** Seed a directory into the virtual filesystem */
	seedDirectory: (absolutePath: string) => void;

	/** Clear all entries — call this in beforeEach to reset between tests */
	reset: () => void;

	/** Get the mock object suitable for `vi.mock('node:fs/promises')` return */
	asMock: () => {
		default: {
			readFile: (...arguments_: unknown[]) => Promise<string | Buffer>;
			writeFile: (path: string, content: string | Buffer) => Promise<void>;
			stat: (path: string) => Promise<{
				size: number;
				mtime: Date;
				mtimeMs: number;
				isDirectory: () => boolean;
				isFile: () => boolean;
			}>;
			readdir: (
				path: string,
				options?: { withFileTypes?: boolean },
			) => Promise<
				Array<
					| string
					| {
							name: string;
							isDirectory: () => boolean;
							isFile: () => boolean;
					  }
				>
			>;
			access: (path: string) => Promise<void>;
			mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
			unlink: (path: string) => Promise<void>;
			rename: (from: string, to: string) => Promise<void>;
			rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
		};
	};
}

function makeEnoentError(path: string): Error {
	const error = new Error(`ENOENT: no such file or directory, '${path}'`);
	(error as NodeJS.ErrnoException).code = 'ENOENT';
	return error;
}

export function createMemoryFs(): MemoryFs {
	const store = new Map<string, MemoryFsEntry>();

	/** Clear all entries — call this in beforeEach to reset between tests */
	function reset(): void {
		store.clear();
	}

	function seedFile(absolutePath: string, content: string | Buffer): void {
		store.set(absolutePath, {
			content,
			mtime: new Date(),
			isDirectory: false,
		});
		// Ensure parent directories exist
		const parts = absolutePath.split('/');
		for (let index = 1; index < parts.length - 1; index++) {
			const directoryPath = parts.slice(0, index + 1).join('/');
			if (!store.has(directoryPath)) {
				store.set(directoryPath, { content: '', mtime: new Date(), isDirectory: true });
			}
		}
	}

	function seedDirectory(absolutePath: string): void {
		store.set(absolutePath, { content: '', mtime: new Date(), isDirectory: true });
	}

	function asMock() {
		return {
			default: {
				readFile: async (...arguments_: unknown[]): Promise<string | Buffer> => {
					const path = arguments_[0] as string;
					const encoding = typeof arguments_[1] === 'string' ? arguments_[1] : undefined;
					const entry = store.get(path);
					if (!entry || entry.isDirectory) {
						throw makeEnoentError(path);
					}
					// eslint-disable-next-line unicorn/text-encoding-identifier-case -- mock must match both encoding forms callers may pass
					if (encoding === 'utf8' || encoding === 'utf-8') {
						return typeof entry.content === 'string' ? entry.content : entry.content.toString('utf8');
					}
					// Return as Buffer for binary reads
					return typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
				},

				writeFile: async (path: string, content: string | Buffer): Promise<void> => {
					const existing = store.get(path);
					store.set(path, {
						content,
						mtime: new Date(),
						isDirectory: false,
					});
					// Preserve existing entry's directory status — but we're writing a file
					if (existing?.isDirectory) {
						throw new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
					}
				},

				stat: async (path: string) => {
					let normalizedPath = path.replaceAll(/\/+/g, '/');
					if (normalizedPath.endsWith('/') && normalizedPath.length > 1) {
						normalizedPath = normalizedPath.slice(0, -1);
					}
					const entry = store.get(normalizedPath);
					if (!entry) {
						throw makeEnoentError(path);
					}
					const size = typeof entry.content === 'string' ? Buffer.byteLength(entry.content, 'utf8') : entry.content.length;
					return {
						size,
						mtime: entry.mtime,
						mtimeMs: entry.mtime.getTime(),
						isDirectory: () => entry.isDirectory,
						isFile: () => !entry.isDirectory,
					};
				},

				readdir: async (path: string, options?: { withFileTypes?: boolean }) => {
					// Normalize path — remove trailing slash for consistency
					const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;

					// Check if path itself is a known directory
					const directoryEntry = store.get(normalizedPath);
					if (directoryEntry && !directoryEntry.isDirectory) {
						throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
					}

					// Collect immediate children
					const prefix = normalizedPath + '/';
					const childrenMap = new Map<string, boolean>();

					for (const [key, entry] of store) {
						if (!key.startsWith(prefix)) continue;
						const remainder = key.slice(prefix.length);
						// Immediate child: no further slashes
						const slashIndex = remainder.indexOf('/');
						if (slashIndex === -1) {
							childrenMap.set(remainder, entry.isDirectory);
						} else {
							// This is a nested path — the first segment is a directory child
							const childName = remainder.slice(0, slashIndex);
							if (!childrenMap.has(childName)) {
								childrenMap.set(childName, true);
							}
						}
					}

					if (childrenMap.size === 0 && !directoryEntry) {
						throw makeEnoentError(path);
					}

					if (options?.withFileTypes) {
						return [...childrenMap.entries()].map(([name, isDirectory]) => ({
							name,
							isDirectory: () => isDirectory,
							isFile: () => !isDirectory,
						}));
					}

					return [...childrenMap.keys()];
				},

				access: async (path: string): Promise<void> => {
					const entry = store.get(path);
					if (!entry) {
						throw makeEnoentError(path);
					}
				},

				mkdir: async (_path: string, _options?: { recursive?: boolean }): Promise<void> => {
					// No-op — directories are implicit from file paths in the memory store
				},

				unlink: async (path: string): Promise<void> => {
					if (!store.has(path)) {
						throw makeEnoentError(path);
					}
					store.delete(path);
				},

				rename: async (from: string, to: string): Promise<void> => {
					const entry = store.get(from);
					if (!entry) {
						throw makeEnoentError(from);
					}
					store.set(to, { ...entry, mtime: new Date() });
					store.delete(from);
				},

				rm: async (path: string, _options?: { recursive?: boolean; force?: boolean }): Promise<void> => {
					// Remove path and all children
					const prefix = path + '/';
					for (const key of store.keys()) {
						if (key === path || key.startsWith(prefix)) {
							store.delete(key);
						}
					}
				},
			},
		};
	}

	return { store, seedFile, seedDirectory, reset, asMock };
}

// =============================================================================
// Mock Context Factory
// =============================================================================

export function createMockContext(overrides?: Partial<ToolExecutorContext>): ToolExecutorContext {
	return {
		projectRoot: '/project',
		projectId: 'test-project',
		mode: 'code',
		sessionId: 'test-session',
		callMcpTool: async () => 'mock-mcp-result',
		...overrides,
	};
}

// =============================================================================
// Mock SendEvent Factory
// =============================================================================

export function createMockSendEvent(): SendEventFunction & { calls: Array<[string, Record<string, unknown>]> } {
	const calls: Array<[string, Record<string, unknown>]> = [];
	const function_ = (type: string, data: Record<string, unknown>) => {
		calls.push([type, data]);
	};
	function_.calls = calls;
	return function_ as SendEventFunction & { calls: Array<[string, Record<string, unknown>]> };
}

// =============================================================================
// Mock Coordinator
// =============================================================================

const noopTriggerUpdate = async (_update: unknown) => {};

export function createCoordinatorMock() {
	return {
		triggerUpdate: noopTriggerUpdate,
		mockNamespace: {
			idFromName: (_name: string) => ({ toString: () => 'mock-id' }),
			get: (_id: unknown) => ({ triggerUpdate: noopTriggerUpdate }),
		},
	};
}
