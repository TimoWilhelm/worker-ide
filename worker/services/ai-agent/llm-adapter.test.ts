/**
 * Unit tests for tool call parsing logic.
 * Tests parseToolCalls from utilities.ts which is used by the LLM adapter.
 */

import { describe, expect, it } from 'vitest';

import { parseToolCalls } from './utilities';

import type { ParsedToolCall } from './utilities';

// =============================================================================
// parseToolCalls
// =============================================================================

describe('parseToolCalls', () => {
	describe('basic parsing', () => {
		it('parses a single tool call', () => {
			const output = '<tool_use>\n{"name": "file_read", "input": {"path": "/index.html"}}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0]).toEqual({
				name: 'file_read',
				input: { path: '/index.html' },
			});
			expect(result.textParts).toHaveLength(0);
		});

		it('parses multiple tool calls', () => {
			const output = [
				'<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt"}}\n</tool_use>',
				'<tool_use>\n{"name": "file_write", "input": {"path": "/b.txt", "content": "hello"}}\n</tool_use>',
			].join('\n');

			const result = parseToolCalls(output);
			expect(result.toolCalls).toHaveLength(2);
			expect(result.toolCalls[0].name).toBe('file_read');
			expect(result.toolCalls[1].name).toBe('file_write');
		});

		it('extracts text before tool calls', () => {
			const output = 'I will read the file.\n<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt"}}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.textParts).toEqual(['I will read the file.']);
			expect(result.toolCalls).toHaveLength(1);
		});

		it('extracts text after tool calls', () => {
			const output = '<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt"}}\n</tool_use>\nDone reading.';
			const result = parseToolCalls(output);

			expect(result.textParts).toEqual(['Done reading.']);
			expect(result.toolCalls).toHaveLength(1);
		});

		it('extracts interstitial text between tool calls', () => {
			const output = [
				'First I will read.',
				'<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt"}}\n</tool_use>',
				'Now I will write.',
				'<tool_use>\n{"name": "file_write", "input": {"path": "/b.txt", "content": "x"}}\n</tool_use>',
				'All done.',
			].join('\n');

			const result = parseToolCalls(output);
			expect(result.textParts).toEqual(['First I will read.', 'Now I will write.', 'All done.']);
			expect(result.toolCalls).toHaveLength(2);
		});

		it('returns only text when no tool calls present', () => {
			const output = 'This is just a normal response with no tools.';
			const result = parseToolCalls(output);

			expect(result.toolCalls).toHaveLength(0);
			expect(result.textParts).toEqual(['This is just a normal response with no tools.']);
		});

		it('handles empty output', () => {
			const result = parseToolCalls('');
			expect(result.toolCalls).toHaveLength(0);
			expect(result.textParts).toHaveLength(0);
		});
	});

	describe('input extraction patterns', () => {
		it('extracts input from canonical format (nested input object)', () => {
			const output = '<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt"}}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls[0].input).toEqual({ path: '/a.txt' });
		});

		it('extracts input from flat format (top-level keys)', () => {
			const output = '<tool_use>\n{"name": "file_read", "path": "/a.txt"}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls[0].input).toEqual({ path: '/a.txt' });
		});

		it('handles no-argument tools', () => {
			const output = '<tool_use>\n{"name": "files_list"}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls[0]).toEqual({ name: 'files_list', input: {} });
		});

		it('handles no-argument tools with empty input object', () => {
			const output = '<tool_use>\n{"name": "files_list", "input": {}}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls[0]).toEqual({ name: 'files_list', input: {} });
		});
	});

	describe('value coercion', () => {
		it('preserves string values', () => {
			const output = '<tool_use>\n{"name": "file_write", "input": {"path": "/a.txt", "content": "hello"}}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls[0].input.path).toBe('/a.txt');
			expect(result.toolCalls[0].input.content).toBe('hello');
		});

		it('serializes numeric values as JSON', () => {
			const output = '<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt", "max_lines": 100}}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls[0].input.max_lines).toBe('100');
		});

		it('serializes boolean values as JSON', () => {
			const output = '<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt", "recursive": true}}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls[0].input.recursive).toBe('true');
		});

		it('serializes object values as JSON strings', () => {
			const output = '<tool_use>\n{"name": "test_tool", "input": {"config": {"key": "value"}}}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls[0].input.config).toBe('{"key":"value"}');
		});
	});

	describe('error recovery', () => {
		it('handles malformed JSON by treating block as text', () => {
			const output = '<tool_use>\nnot valid json at all\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls).toHaveLength(0);
			expect(result.textParts).toHaveLength(1);
			expect(result.textParts[0]).toContain('<tool_use>');
		});

		it('handles truncated output with unclosed tool_use tag', () => {
			const output = 'Some text\n<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt"}';
			const result = parseToolCalls(output);

			// Should attempt to parse the truncated JSON via repair
			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0].name).toBe('file_read');
			expect(result.textParts).toEqual(['Some text']);
		});

		it('handles truncated output with completely broken JSON', () => {
			const output = 'Some text\n<tool_use>\n{"name": ';
			const result = parseToolCalls(output);

			// Should treat as text since JSON is too broken to recover name
			expect(result.toolCalls).toHaveLength(0);
			expect(result.textParts.length).toBeGreaterThan(0);
		});

		it('filters out tool calls with empty names', () => {
			const output = '<tool_use>\n{"name": "", "input": {"path": "/a.txt"}}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls).toHaveLength(0);
			expect(result.textParts).toHaveLength(1);
		});

		it('handles JSON with trailing commas via repair', () => {
			const output = '<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt",}}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0].name).toBe('file_read');
		});

		it('handles JSON with unclosed braces via repair', () => {
			const output = '<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt"}\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0].name).toBe('file_read');
		});

		it('handles markdown code fences in JSON via repair', () => {
			const output = '<tool_use>\n```json\n{"name": "file_read", "input": {"path": "/a.txt"}}\n```\n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0].name).toBe('file_read');
		});

		it('never throws regardless of input', () => {
			const edgeCases = [
				'<tool_use>',
				'</tool_use>',
				'<tool_use></tool_use>',
				'<tool_use>\u0000\u0001\u0002</tool_use>',
				'<tool_use>\n\n\n</tool_use>',
				'<tool_use>' + '}'.repeat(1000) + '</tool_use>',
				'<tool_use>' + '{'.repeat(1000),
			];

			for (const input of edgeCases) {
				expect(() => parseToolCalls(input)).not.toThrow();
			}
		});

		it('recovers partial results when one block fails', () => {
			const output = [
				'<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt"}}\n</tool_use>',
				'<tool_use>\nnot valid json\n</tool_use>',
				'<tool_use>\n{"name": "file_write", "input": {"path": "/b.txt", "content": "x"}}\n</tool_use>',
			].join('\n');

			const result = parseToolCalls(output);
			expect(result.toolCalls).toHaveLength(2);
			expect(result.toolCalls[0].name).toBe('file_read');
			expect(result.toolCalls[1].name).toBe('file_write');
			// The failed block should appear as text
			expect(result.textParts.some((text) => text.includes('not valid json'))).toBe(true);
		});
	});

	describe('whitespace handling', () => {
		it('trims whitespace from text parts', () => {
			const output = '  \n  Some text  \n  \n<tool_use>\n{"name": "files_list"}\n</tool_use>\n  \n  More text  \n  ';
			const result = parseToolCalls(output);

			for (const part of result.textParts) {
				expect(part).toBe(part.trim());
			}
		});

		it('handles tool_use tags with extra whitespace inside', () => {
			const output = '<tool_use>\n  \n  {"name": "files_list", "input": {}}  \n  \n</tool_use>';
			const result = parseToolCalls(output);

			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0].name).toBe('files_list');
		});
	});
});

// =============================================================================
// Type-level test: ParsedToolCall shape
// =============================================================================

describe('ParsedToolCall type', () => {
	it('has the expected shape', () => {
		const toolCall: ParsedToolCall = {
			name: 'file_read',
			input: { path: '/a.txt' },
		};
		expect(toolCall.name).toBe('file_read');
		expect(toolCall.input.path).toBe('/a.txt');
	});
});
