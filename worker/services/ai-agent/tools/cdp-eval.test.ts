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

		expect(result.metadata).toHaveProperty('method', 'Runtime.evaluate');
		expect(result.metadata).toHaveProperty('result');
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

		expect(result.metadata).toHaveProperty('method', 'DOM.getDocument');
		expect(result.metadata).toHaveProperty('result');
	});

	// ── CDP errors ────────────────────────────────────────────────────────

	it('returns graceful result when no browser is connected', async () => {
		const mockSendCdpCommand = vi.fn().mockResolvedValue({
			error: 'No browser is connected to the project. The CDP command cannot be relayed to a preview iframe.',
		});
		const context = createMockContext({ sendCdpCommand: mockSendCdpCommand });

		const result = await execute({ method: 'Runtime.evaluate', params: '{"expression": "x"}' }, createMockSendEvent(), context);

		expect(result.output).toContain('could not be executed');
		expect(result.output).toContain('No browser is connected');
		expect(result.output).toContain('do not retry');
	});

	it('returns graceful result when CDP command times out', async () => {
		const mockSendCdpCommand = vi.fn().mockResolvedValue({
			error: 'CDP command timed out. The preview iframe may not be loaded or chobitsu is not responding.',
		});
		const context = createMockContext({ sendCdpCommand: mockSendCdpCommand });

		const result = await execute({ method: 'Runtime.evaluate', params: '{"expression": "x"}' }, createMockSendEvent(), context);

		expect(result.output).toContain('could not be executed');
		expect(result.output).toContain('timed out');
	});

	it('returns graceful result when client connection fails', async () => {
		const mockSendCdpCommand = vi.fn().mockResolvedValue({
			error: 'Failed to send CDP command to the client. The connection may have closed.',
		});
		const context = createMockContext({ sendCdpCommand: mockSendCdpCommand });

		const result = await execute({ method: 'Runtime.evaluate', params: '{"expression": "x"}' }, createMockSendEvent(), context);

		expect(result.output).toContain('could not be executed');
		expect(result.output).toContain('Failed to send CDP command');
	});

	it('throws error for non-connection CDP errors', async () => {
		const mockSendCdpCommand = vi.fn().mockResolvedValue({ error: 'Unexpected protocol error' });
		const context = createMockContext({ sendCdpCommand: mockSendCdpCommand });

		await expect(execute({ method: 'Runtime.evaluate', params: '{"expression": "x"}' }, createMockSendEvent(), context)).rejects.toThrow(
			'Unexpected protocol error',
		);
	});

	// ── JSON parsing errors ───────────────────────────────────────────────

	it('throws error for invalid params JSON', async () => {
		const context = createMockContext({
			sendCdpCommand: vi.fn().mockResolvedValue({ result: 'ok' }),
		});

		await expect(execute({ method: 'Runtime.evaluate', params: 'not valid json{{{' }, createMockSendEvent(), context)).rejects.toThrow(
			'Invalid params',
		);
	});

	it('rejects array params', async () => {
		const context = createMockContext({
			sendCdpCommand: vi.fn().mockResolvedValue({ result: 'ok' }),
		});

		await expect(execute({ method: 'Runtime.evaluate', params: '[1, 2, 3]' }, createMockSendEvent(), context)).rejects.toThrow(
			'must be a JSON object',
		);
	});

	it('rejects primitive params', async () => {
		const context = createMockContext({
			sendCdpCommand: vi.fn().mockResolvedValue({ result: 'ok' }),
		});

		await expect(execute({ method: 'Runtime.evaluate', params: '"just a string"' }, createMockSendEvent(), context)).rejects.toThrow(
			'must be a JSON object',
		);
	});

	// ── No CDP available ──────────────────────────────────────────────────

	it('throws error when sendCdpCommand is not available', async () => {
		const context = createMockContext({ sendCdpCommand: undefined });

		await expect(execute({ method: 'Runtime.evaluate' }, createMockSendEvent(), context)).rejects.toThrow('not available');
	});

	// ── Missing method ────────────────────────────────────────────────────

	it('throws error when method is empty', async () => {
		const context = createMockContext({
			sendCdpCommand: vi.fn().mockResolvedValue({ result: 'ok' }),
		});

		await expect(execute({ method: '' }, createMockSendEvent(), context)).rejects.toThrow('required');
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
