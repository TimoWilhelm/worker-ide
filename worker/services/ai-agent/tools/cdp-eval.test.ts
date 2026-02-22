/**
 * Integration tests for the cdp_eval tool.
 *
 * Tests CDP command delegation, JSON param parsing, and error handling.
 * The sendCdpCommand context method is mocked since no browser
 * is available in the test environment.
 */

import { describe, expect, it, vi } from 'vitest';

import { execute } from './cdp-eval';
import { createMockContext, createMockSendEvent } from './test-helpers';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cdp_eval', () => {
	// ── Successful command ─────────────────────────────────────────────────

	it('executes a CDP command and returns result', async () => {
		const mockSendCdpCommand = vi.fn().mockResolvedValue({ result: '{"type":"string","value":"Hello"}' });
		const context = createMockContext({ sendCdpCommand: mockSendCdpCommand });

		const result = await execute(
			{ method: 'Runtime.evaluate', params: '{"expression": "document.title", "returnByValue": true}' },
			createMockSendEvent(),
			context,
		);

		expect(result).toHaveProperty('method', 'Runtime.evaluate');
		expect(result).toHaveProperty('result');
		expect(mockSendCdpCommand).toHaveBeenCalledOnce();
		// Verify params were parsed and passed
		const callArguments = mockSendCdpCommand.mock.calls[0];
		expect(callArguments[1]).toBe('Runtime.evaluate');
		expect(callArguments[2]).toHaveProperty('expression', 'document.title');
	});

	it('executes a command without params', async () => {
		const mockSendCdpCommand = vi.fn().mockResolvedValue({ result: '{"nodeId":1}' });
		const context = createMockContext({ sendCdpCommand: mockSendCdpCommand });

		const result = await execute({ method: 'DOM.getDocument' }, createMockSendEvent(), context);

		expect(result).toHaveProperty('method', 'DOM.getDocument');
		expect(result).toHaveProperty('result');
	});

	// ── CDP error ─────────────────────────────────────────────────────────

	it('returns error from CDP command', async () => {
		const mockSendCdpCommand = vi.fn().mockResolvedValue({ error: 'No browser connected' });
		const context = createMockContext({ sendCdpCommand: mockSendCdpCommand });

		const result = await execute({ method: 'Runtime.evaluate', params: '{"expression": "x"}' }, createMockSendEvent(), context);

		expect(result).toHaveProperty('error', 'No browser connected');
	});

	// ── JSON parsing errors ───────────────────────────────────────────────

	it('returns error for invalid params JSON', async () => {
		const context = createMockContext({
			sendCdpCommand: vi.fn().mockResolvedValue({ result: 'ok' }),
		});

		const result = await execute({ method: 'Runtime.evaluate', params: 'not valid json{{{' }, createMockSendEvent(), context);

		expect(result).toHaveProperty('error');
		const errorResult = result as { error: string };
		expect(errorResult.error).toContain('Invalid params');
	});

	it('rejects array params', async () => {
		const context = createMockContext({
			sendCdpCommand: vi.fn().mockResolvedValue({ result: 'ok' }),
		});

		const result = await execute({ method: 'Runtime.evaluate', params: '[1, 2, 3]' }, createMockSendEvent(), context);

		expect(result).toHaveProperty('error');
		const errorResult = result as { error: string };
		expect(errorResult.error).toContain('must be a JSON object');
	});

	it('rejects primitive params', async () => {
		const context = createMockContext({
			sendCdpCommand: vi.fn().mockResolvedValue({ result: 'ok' }),
		});

		const result = await execute({ method: 'Runtime.evaluate', params: '"just a string"' }, createMockSendEvent(), context);

		expect(result).toHaveProperty('error');
		const errorResult = result as { error: string };
		expect(errorResult.error).toContain('must be a JSON object');
	});

	// ── No CDP available ──────────────────────────────────────────────────

	it('returns error when sendCdpCommand is not available', async () => {
		const context = createMockContext({ sendCdpCommand: undefined });

		const result = await execute({ method: 'Runtime.evaluate' }, createMockSendEvent(), context);

		expect(result).toHaveProperty('error');
		const errorResult = result as { error: string };
		expect(errorResult.error).toContain('not available');
	});

	// ── Missing method ────────────────────────────────────────────────────

	it('returns error when method is empty', async () => {
		const context = createMockContext({
			sendCdpCommand: vi.fn().mockResolvedValue({ result: 'ok' }),
		});

		const result = await execute({ method: '' }, createMockSendEvent(), context);

		expect(result).toHaveProperty('error');
		const errorResult = result as { error: string };
		expect(errorResult.error).toContain('required');
	});

	// ── Status event ──────────────────────────────────────────────────────

	it('sends status event', async () => {
		const sendEvent = createMockSendEvent();
		const context = createMockContext({
			sendCdpCommand: vi.fn().mockResolvedValue({ result: 'ok' }),
		});

		await execute({ method: 'DOM.getDocument' }, sendEvent, context);

		const statusEvent = sendEvent.calls.find(([type]) => type === 'status');
		expect(statusEvent).toBeDefined();
	});
});
