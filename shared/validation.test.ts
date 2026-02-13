/**
 * Unit tests for validation schemas.
 */

import { describe, expect, it } from 'vitest';

import {
	filePathSchema,
	writeFileSchema,
	aiChatMessageSchema,
	sessionIdSchema,
	snapshotIdSchema,
	todoItemSchema,
	isPathSafe,
	validateToolInput,
	LIMITS,
} from './validation';

// =============================================================================
// filePathSchema
// =============================================================================

describe('filePathSchema', () => {
	it('accepts valid paths', () => {
		expect(filePathSchema.safeParse('/src/main.ts').success).toBe(true);
		expect(filePathSchema.safeParse('/file.ts').success).toBe(true);
		expect(filePathSchema.safeParse('/a/b/c/d.tsx').success).toBe(true);
	});

	it('rejects empty paths', () => {
		expect(filePathSchema.safeParse('').success).toBe(false);
	});

	it('rejects paths without leading slash', () => {
		expect(filePathSchema.safeParse('src/main.ts').success).toBe(false);
	});

	it('rejects paths with ..', () => {
		expect(filePathSchema.safeParse('/src/../etc/passwd').success).toBe(false);
	});

	it('rejects paths with consecutive slashes', () => {
		expect(filePathSchema.safeParse('/src//main.ts').success).toBe(false);
	});

	it('rejects paths exceeding max length', () => {
		const longPath = '/' + 'a'.repeat(LIMITS.PATH_MAX_LENGTH);
		expect(filePathSchema.safeParse(longPath).success).toBe(false);
	});
});

// =============================================================================
// writeFileSchema
// =============================================================================

describe('writeFileSchema', () => {
	it('accepts valid write input', () => {
		const result = writeFileSchema.safeParse({
			path: '/src/main.ts',
			content: 'console.log("hello");',
		});
		expect(result.success).toBe(true);
	});

	it('rejects missing path', () => {
		const result = writeFileSchema.safeParse({
			content: 'hello',
		});
		expect(result.success).toBe(false);
	});

	it('rejects missing content', () => {
		const result = writeFileSchema.safeParse({
			path: '/src/main.ts',
		});
		expect(result.success).toBe(false);
	});
});

// =============================================================================
// aiChatMessageSchema
// =============================================================================

describe('aiChatMessageSchema', () => {
	it('accepts valid chat input', () => {
		const result = aiChatMessageSchema.safeParse({
			message: 'Help me fix this bug',
		});
		expect(result.success).toBe(true);
	});

	it('accepts input with history', () => {
		const result = aiChatMessageSchema.safeParse({
			message: 'Continue',
			history: [{ role: 'user', content: 'previous message' }],
		});
		expect(result.success).toBe(true);
	});

	it('rejects empty message', () => {
		const result = aiChatMessageSchema.safeParse({
			message: '',
		});
		expect(result.success).toBe(false);
	});

	it('rejects message exceeding max length', () => {
		const result = aiChatMessageSchema.safeParse({
			message: 'a'.repeat(LIMITS.AI_MESSAGE_MAX_LENGTH + 1),
		});
		expect(result.success).toBe(false);
	});
});

// =============================================================================
// sessionIdSchema
// =============================================================================

describe('sessionIdSchema', () => {
	it('accepts valid session IDs', () => {
		expect(sessionIdSchema.safeParse('abc123').success).toBe(true);
	});

	it('rejects uppercase characters', () => {
		expect(sessionIdSchema.safeParse('ABC123').success).toBe(false);
	});

	it('rejects special characters', () => {
		expect(sessionIdSchema.safeParse('abc-123').success).toBe(false);
	});

	it('rejects empty string', () => {
		expect(sessionIdSchema.safeParse('').success).toBe(false);
	});
});

// =============================================================================
// snapshotIdSchema
// =============================================================================

describe('snapshotIdSchema', () => {
	it('accepts valid hex IDs', () => {
		expect(snapshotIdSchema.safeParse('abcdef0123456789').success).toBe(true);
	});

	it('rejects non-hex characters', () => {
		expect(snapshotIdSchema.safeParse('xyz123').success).toBe(false);
	});

	it('rejects empty string', () => {
		expect(snapshotIdSchema.safeParse('').success).toBe(false);
	});
});

// =============================================================================
// isPathSafe
// =============================================================================

describe('isPathSafe', () => {
	it('returns true for valid paths', () => {
		expect(isPathSafe('/src/main.ts')).toBe(true);
	});

	it('returns false for path traversal', () => {
		expect(isPathSafe('/src/../etc/passwd')).toBe(false);
	});

	it('returns false for paths without leading slash', () => {
		expect(isPathSafe('src/main.ts')).toBe(false);
	});
});

// =============================================================================
// validateToolInput
// =============================================================================

describe('validateToolInput', () => {
	it('validates read_file input', () => {
		const result = validateToolInput('read_file', { path: '/src/main.ts' });
		expect(result.success).toBe(true);
	});

	it('rejects invalid read_file input', () => {
		const result = validateToolInput('read_file', { path: 'invalid' });
		expect(result.success).toBe(false);
	});

	it('validates write_file input', () => {
		const result = validateToolInput('write_file', {
			path: '/src/main.ts',
			content: 'hello',
		});
		expect(result.success).toBe(true);
	});

	it('validates list_files input (empty object)', () => {
		const result = validateToolInput('list_files', {});
		expect(result.success).toBe(true);
	});

	it('validates delete_file input', () => {
		const result = validateToolInput('delete_file', { path: '/src/old.ts' });
		expect(result.success).toBe(true);
	});

	it('validates move_file input', () => {
		const result = validateToolInput('move_file', {
			from_path: '/src/old.ts',
			to_path: '/src/new.ts',
		});
		expect(result.success).toBe(true);
	});

	it('validates search_cloudflare_docs input', () => {
		const result = validateToolInput('search_cloudflare_docs', { query: 'Workers KV' });
		expect(result.success).toBe(true);
	});

	it('rejects search_cloudflare_docs with empty query', () => {
		const result = validateToolInput('search_cloudflare_docs', { query: '' });
		expect(result.success).toBe(false);
	});

	it('validates get_todos input (empty object)', () => {
		const result = validateToolInput('get_todos', {});
		expect(result.success).toBe(true);
	});

	it('validates update_todos input', () => {
		const result = validateToolInput('update_todos', {
			todos: [
				{ id: '1', content: 'Fix bug', status: 'pending', priority: 'high' },
				{ id: '2', content: 'Add tests', status: 'in_progress', priority: 'medium' },
			],
		});
		expect(result.success).toBe(true);
	});

	it('rejects update_todos with invalid status', () => {
		const result = validateToolInput('update_todos', {
			todos: [{ id: '1', content: 'Fix bug', status: 'unknown', priority: 'high' }],
		});
		expect(result.success).toBe(false);
	});

	it('rejects update_todos with invalid priority', () => {
		const result = validateToolInput('update_todos', {
			todos: [{ id: '1', content: 'Fix bug', status: 'pending', priority: 'critical' }],
		});
		expect(result.success).toBe(false);
	});

	it('rejects update_todos with missing fields', () => {
		const result = validateToolInput('update_todos', {
			todos: [{ id: '1', content: 'Fix bug' }],
		});
		expect(result.success).toBe(false);
	});
});

// =============================================================================
// todoItemSchema
// =============================================================================

describe('todoItemSchema', () => {
	it('accepts a valid TODO item', () => {
		const result = todoItemSchema.safeParse({
			id: 'task-1',
			content: 'Implement feature',
			status: 'pending',
			priority: 'high',
		});
		expect(result.success).toBe(true);
	});

	it('accepts all valid statuses', () => {
		for (const status of ['pending', 'in_progress', 'completed']) {
			const result = todoItemSchema.safeParse({
				id: '1',
				content: 'Task',
				status,
				priority: 'low',
			});
			expect(result.success).toBe(true);
		}
	});

	it('accepts all valid priorities', () => {
		for (const priority of ['high', 'medium', 'low']) {
			const result = todoItemSchema.safeParse({
				id: '1',
				content: 'Task',
				status: 'pending',
				priority,
			});
			expect(result.success).toBe(true);
		}
	});

	it('rejects empty id', () => {
		const result = todoItemSchema.safeParse({
			id: '',
			content: 'Task',
			status: 'pending',
			priority: 'high',
		});
		expect(result.success).toBe(false);
	});

	it('rejects empty content', () => {
		const result = todoItemSchema.safeParse({
			id: '1',
			content: '',
			status: 'pending',
			priority: 'high',
		});
		expect(result.success).toBe(false);
	});
});

// =============================================================================
// aiChatMessageSchema — plan mode and session ID
// =============================================================================

describe('aiChatMessageSchema plan mode fields', () => {
	it('accepts planMode boolean', () => {
		const result = aiChatMessageSchema.safeParse({
			message: 'Create a plan',
			planMode: true,
		});
		expect(result.success).toBe(true);
	});

	it('accepts sessionId string', () => {
		const result = aiChatMessageSchema.safeParse({
			message: 'Hello',
			sessionId: 'abc123',
		});
		expect(result.success).toBe(true);
	});

	it('accepts both planMode and sessionId', () => {
		const result = aiChatMessageSchema.safeParse({
			message: 'Plan this feature',
			planMode: true,
			sessionId: 'session1',
		});
		expect(result.success).toBe(true);
	});

	it('rejects sessionId exceeding max length', () => {
		const result = aiChatMessageSchema.safeParse({
			message: 'Hello',
			sessionId: 'a'.repeat(LIMITS.SESSION_ID_MAX_LENGTH + 1),
		});
		expect(result.success).toBe(false);
	});
});
