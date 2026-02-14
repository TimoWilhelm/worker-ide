/**
 * Unit tests for AI Agent utility functions.
 */

import { describe, expect, it } from 'vitest';

import { normalizeFunctionCallsFormat, repairToolCallJson } from './utilities';

// =============================================================================
// normalizeFunctionCallsFormat
// =============================================================================

describe('normalizeFunctionCallsFormat', () => {
	it('converts a single <function_calls> block to <tool_use>', () => {
		const input =
			'<function_calls> <invoke> <parameter name="name">file_read</parameter> <parameter name="input">{"path": "/index.html"}</parameter> </invoke> </function_calls>';

		const result = normalizeFunctionCallsFormat(input);

		expect(result).toContain('<tool_use>');
		expect(result).toContain('"name": "file_read"');
		expect(result).toContain('"input": {"path": "/index.html"}');
		expect(result).toContain('</tool_use>');
		expect(result).not.toContain('<function_calls>');
	});

	it('converts multiple <function_calls> blocks', () => {
		const input = [
			'Some text before',
			'<function_calls> <invoke> <parameter name="name">files_list</parameter> <parameter name="input">{}</parameter> </invoke> </function_calls>',
			'Some text between',
			'<function_calls> <invoke> <parameter name="name">file_read</parameter> <parameter name="input">{"path": "/src"}</parameter> </invoke> </function_calls>',
		].join('\n');

		const result = normalizeFunctionCallsFormat(input);

		expect(result).not.toContain('<function_calls>');
		expect(result).toContain('"name": "files_list"');
		expect(result).toContain('"name": "file_read"');
		expect(result).toContain('Some text before');
		expect(result).toContain('Some text between');
	});

	it('leaves text without <function_calls> unchanged', () => {
		const input = 'Just a normal response with no tool calls.';
		expect(normalizeFunctionCallsFormat(input)).toBe(input);
	});

	it('leaves existing <tool_use> blocks unchanged', () => {
		const input = '<tool_use>\n{"name": "file_read", "input": {"path": "/a.txt"}}\n</tool_use>';
		expect(normalizeFunctionCallsFormat(input)).toBe(input);
	});

	it('handles multiline <function_calls> blocks', () => {
		const input = `<function_calls>
  <invoke>
    <parameter name="name">file_read</parameter>
    <parameter name="input">{"path": "/index.html"}</parameter>
  </invoke>
</function_calls>`;

		const result = normalizeFunctionCallsFormat(input);

		expect(result).toContain('<tool_use>');
		expect(result).toContain('"name": "file_read"');
		expect(result).not.toContain('<function_calls>');
	});

	it('handles empty input object', () => {
		const input =
			'<function_calls> <invoke> <parameter name="name">files_list</parameter> <parameter name="input">{}</parameter> </invoke> </function_calls>';

		const result = normalizeFunctionCallsFormat(input);
		const jsonMatch = result.match(/<tool_use>\n([\s\S]*?)\n<\/tool_use>/);

		expect(jsonMatch).not.toBeUndefined();
		const parsed = JSON.parse(jsonMatch![1]);
		expect(parsed.name).toBe('files_list');
		expect(parsed.input).toEqual({});
	});
});

// =============================================================================
// repairToolCallJson
// =============================================================================

describe('repairToolCallJson', () => {
	it('returns valid JSON as-is', () => {
		const json = '{"name": "file_read", "input": {"path": "/a.txt"}}';
		expect(repairToolCallJson(json)).toBe(json);
	});

	it('strips markdown code fences', () => {
		const json = '```json\n{"name": "file_read"}\n```';
		expect(repairToolCallJson(json)).toBe('{"name": "file_read"}');
	});

	it('removes trailing commas', () => {
		const json = '{"name": "file_read",}';
		expect(repairToolCallJson(json)).toBe('{"name": "file_read"}');
	});

	it('closes unclosed braces', () => {
		const json = '{"name": "file_read"';
		expect(repairToolCallJson(json)).toBe('{"name": "file_read"}');
	});

	it('returns undefined for unrecoverable JSON', () => {
		expect(repairToolCallJson('not json at all {{{')).toBeUndefined();
	});
});
