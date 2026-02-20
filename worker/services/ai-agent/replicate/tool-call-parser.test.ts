/**
 * Unit tests for Replicate tool call parsing logic.
 *
 * Tests normalizeFunctionCallsFormat, parseToolCalls, repairToolCallJson,
 * and the ParsedToolCall type — all Replicate-specific parsing utilities.
 */

import { describe, expect, it } from 'vitest';

import { normalizeFunctionCallsFormat, parseToolCalls, repairToolCallJson } from './tool-call-parser';

import type { ParsedToolCall } from './tool-call-parser';

// =============================================================================
// normalizeFunctionCallsFormat
// =============================================================================

describe('normalizeFunctionCallsFormat', () => {
	// Format A: <function_calls><invoke><parameter name="name">...<parameter name="input">...

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

	// Format B: <invoke name="tool_name"><parameter name="key">value</parameter></invoke>

	it('converts Format B with invoke name attribute and parameter elements', () => {
		const input = `<function_calls>
<invoke name="file_read">
<parameter name="path">/index.html</parameter>
</invoke>
</function_calls>`;

		const result = normalizeFunctionCallsFormat(input);

		expect(result).toContain('<tool_use>');
		expect(result).toContain('"name": "file_read"');
		expect(result).not.toContain('<function_calls>');

		const jsonMatch = result.match(/<tool_use>\n([\s\S]*?)\n<\/tool_use>/);
		expect(jsonMatch).not.toBeUndefined();
		const parsed = JSON.parse(jsonMatch![1]);
		expect(parsed.name).toBe('file_read');
		expect(parsed.input).toEqual({ path: '/index.html' });
	});

	it('converts Format B with no parameters (e.g., files_list)', () => {
		const input = `<function_calls>
<invoke name="files_list">
</invoke>
</function_calls>`;

		const result = normalizeFunctionCallsFormat(input);

		expect(result).toContain('<tool_use>');
		expect(result).toContain('"name": "files_list"');

		const jsonMatch = result.match(/<tool_use>\n([\s\S]*?)\n<\/tool_use>/);
		expect(jsonMatch).not.toBeUndefined();
		const parsed = JSON.parse(jsonMatch![1]);
		expect(parsed.name).toBe('files_list');
		expect(parsed.input).toEqual({});
	});

	it('converts Format B with multiple invoke blocks in one function_calls wrapper', () => {
		const input = `<function_calls>
<invoke name="file_read">
<parameter name="path">/index.html</parameter>
</invoke>
<invoke name="file_read">
<parameter name="path">/src/App.tsx</parameter>
</invoke>
</function_calls>`;

		const result = normalizeFunctionCallsFormat(input);

		expect(result).not.toContain('<function_calls>');
		const matches = [...result.matchAll(/<tool_use>\n([\s\S]*?)\n<\/tool_use>/g)];
		expect(matches).toHaveLength(2);

		const firstCall = JSON.parse(matches[0][1]);
		expect(firstCall.name).toBe('file_read');
		expect(firstCall.input).toEqual({ path: '/index.html' });

		const secondCall = JSON.parse(matches[1][1]);
		expect(secondCall.name).toBe('file_read');
		expect(secondCall.input).toEqual({ path: '/src/App.tsx' });
	});

	it('handles multiple Format B parameters on one invoke', () => {
		const input = `<function_calls>
<invoke name="file_grep">
<parameter name="pattern">.</parameter>
<parameter name="include">.css</parameter>
</invoke>
</function_calls>`;

		const result = normalizeFunctionCallsFormat(input);

		const jsonMatch = result.match(/<tool_use>\n([\s\S]*?)\n<\/tool_use>/);
		expect(jsonMatch).not.toBeUndefined();
		const parsed = JSON.parse(jsonMatch![1]);
		expect(parsed.name).toBe('file_grep');
		expect(parsed.input).toEqual({ pattern: '.', include: '.css' });
	});

	it('handles mixed text and multiple Format B function_calls blocks', () => {
		const input = `Let me explore the project.
<function_calls>
<invoke name="file_read">
<parameter name="path">/</parameter>
</invoke>
</function_calls>
Now let me check more files:
<function_calls>
<invoke name="file_glob">
<parameter name="pattern">src/**/*.tsx</parameter>
</invoke>
</function_calls>`;

		const result = normalizeFunctionCallsFormat(input);

		expect(result).not.toContain('<function_calls>');
		expect(result).toContain('Let me explore the project.');
		expect(result).toContain('Now let me check more files:');

		const matches = [...result.matchAll(/<tool_use>\n([\s\S]*?)\n<\/tool_use>/g)];
		expect(matches).toHaveLength(2);

		const firstCall = JSON.parse(matches[0][1]);
		expect(firstCall.name).toBe('file_read');
		expect(firstCall.input).toEqual({ path: '/' });

		const secondCall = JSON.parse(matches[1][1]);
		expect(secondCall.name).toBe('file_glob');
		expect(secondCall.input).toEqual({ pattern: 'src/**/*.tsx' });
	});

	it('converts Format B with multiline parameter content', () => {
		const input = `<function_calls>
<invoke name="file_patch">
<parameter name="patch">*** Begin Patch
some
multiline
patch content
*** End Patch</parameter>
</invoke>
</function_calls>`;

		const result = normalizeFunctionCallsFormat(input);

		const jsonMatch = result.match(/<tool_use>\n([\s\S]*?)\n<\/tool_use>/);
		expect(jsonMatch).not.toBeUndefined();
		const parsed = JSON.parse(jsonMatch![1]);
		expect(parsed.name).toBe('file_patch');
		expect(parsed.input.patch).toContain('*** Begin Patch');
		expect(parsed.input.patch).toContain('*** End Patch');
	});
});

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
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		expect(JSON.parse(result!)).toEqual({ name: 'file_read' });
	});

	it('returns undefined for unrecoverable JSON', () => {
		expect(repairToolCallJson('not json at all {{{')).toBeUndefined();
	});

	// New tests for the state-machine repair
	it('closes unclosed strings', () => {
		const json = '{"name": "file_read", "input": {"path": "/a.txt';
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		const parsed = JSON.parse(result!);
		expect(parsed.name).toBe('file_read');
		expect(parsed.input.path).toBe('/a.txt');
	});

	it('closes nested objects and arrays', () => {
		const json = '{"name": "test", "input": {"items": [1, 2, 3';
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		const parsed = JSON.parse(result!);
		expect(parsed.name).toBe('test');
		expect(parsed.input.items).toEqual([1, 2, 3]);
	});

	it('completes truncated literals (true)', () => {
		const json = '{"active": tru';
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		const parsed = JSON.parse(result!);
		expect(parsed.active).toBe(true);
	});

	it('completes truncated literals (false)', () => {
		const json = '{"active": fals';
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		const parsed = JSON.parse(result!);
		expect(parsed.active).toBe(false);
	});

	it('completes truncated literals (null)', () => {
		const json = '{"value": nul';
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		const parsed = JSON.parse(result!);

		expect(parsed.value).toBeNull();
	});

	it('drops incomplete key-value pairs', () => {
		const json = '{"k1": 1, "k2":';
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		const parsed = JSON.parse(result!);
		expect(parsed.k1).toBe(1);
	});

	it('handles deeply nested structures', () => {
		const json = '{"a": {"b": {"c": [1, [2, [3';
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		expect(() => JSON.parse(result!)).not.toThrow();
	});

	it('handles escaped characters in strings', () => {
		const json = String.raw`{"content": "line1\nline2\ttab\"quoted\""}`;
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		const parsed = JSON.parse(result!);
		expect(parsed.content).toBe('line1\nline2\ttab"quoted"');
	});

	it('handles empty object', () => {
		const json = '{}';
		expect(repairToolCallJson(json)).toBe('{}');
	});

	it('handles empty array', () => {
		const json = '[]';
		expect(repairToolCallJson(json)).toBe('[]');
	});

	it('handles trailing comma before close bracket in array', () => {
		const json = '[1, 2, 3,]';
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		expect(JSON.parse(result!)).toEqual([1, 2, 3]);
	});

	it('returns a valid result for a bare string', () => {
		const json = '"hello"';
		expect(repairToolCallJson(json)).toBe('"hello"');
	});

	it('repairs a truncated string at root level', () => {
		const json = '"hello';
		const result = repairToolCallJson(json);
		expect(result).toBeDefined();
		expect(JSON.parse(result!)).toBe('hello');
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
