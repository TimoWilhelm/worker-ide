/**
 * Integration tests for the plan_update tool.
 *
 * Tests plan file creation, updates, checkbox counting,
 * and no-change detection against an in-memory filesystem.
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

const { execute } = await import('./plan-update');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT, sessionId: 'ses-123' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan_update', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Creating a new plan ───────────────────────────────────────────────

	it('creates a new plan file and returns line count', async () => {
		const plan = '# Plan\n\n- [ ] Step 1\n- [ ] Step 2\n';

		const result = await execute({ content: plan }, createMockSendEvent(), context());

		expect(result).toHaveProperty('result');
		expect(result).toHaveProperty('path');
		const resultObject = result as { result: string; path: string };
		expect(resultObject.result).toContain('Plan updated');
		expect(resultObject.path).toContain('ses-123.md');
		// File should be written
		expect(memoryFs.store.has(`${PROJECT_ROOT}/.agent/plans/ses-123.md`)).toBe(true);
	});

	// ── Checkbox counting ─────────────────────────────────────────────────

	it('counts completed and pending checkboxes', async () => {
		const plan = '# Plan\n\n- [x] Done 1\n- [x] Done 2\n- [ ] Pending 1\n';

		const result = await execute({ content: plan }, createMockSendEvent(), context());

		const resultObject = result as { result: string };
		expect(resultObject.result).toContain('2/3 tasks completed');
	});

	it('handles plan with no checkboxes', async () => {
		const plan = '# Simple plan\n\nJust notes, no tasks.\n';

		const result = await execute({ content: plan }, createMockSendEvent(), context());

		const resultObject = result as { result: string };
		expect(resultObject.result).not.toContain('tasks completed');
	});

	// ── Plan updates ──────────────────────────────────────────────────────

	it('detects no-change when updating with identical content', async () => {
		const plan = '# Plan\n\n- [ ] Step 1\n';
		// Create initial plan
		memoryFs.seedFile(`${PROJECT_ROOT}/.agent/plans/ses-123.md`, plan);

		const result = await execute({ content: plan }, createMockSendEvent(), context());

		const resultObject = result as { result: string };
		expect(resultObject.result).toContain('no changes');
	});

	// ── Event emission ────────────────────────────────────────────────────

	it('emits plan_updated event', async () => {
		const sendEvent = createMockSendEvent();

		await execute({ content: '# Plan' }, sendEvent, context());

		const planEvent = sendEvent.calls.find(([type]) => type === 'plan_updated');
		expect(planEvent).toBeDefined();
		expect(planEvent![1]).toHaveProperty('content', '# Plan');
	});

	// ── Default session ID ────────────────────────────────────────────────

	it('uses "default" when sessionId is not set', async () => {
		const contextWithoutSession = createMockContext({ projectRoot: PROJECT_ROOT, sessionId: undefined });

		const result = await execute({ content: '# Plan' }, createMockSendEvent(), contextWithoutSession);

		const resultObject = result as { path: string };
		expect(resultObject.path).toContain('default.md');
	});
});
