/**
 * Tool call parsing logic for the Replicate text-completion adapter.
 *
 * Replicate exposes Claude as a text-completion endpoint (not a Messages API),
 * so tool calls must be parsed from XML blocks (`<tool_use>`) in the model's
 * text output. This module handles:
 *
 * - Normalizing alternative XML formats (`<function_calls>/<invoke>`) to `<tool_use>`
 * - Parsing `<tool_use>` blocks into structured tool call objects
 * - Repairing malformed/truncated JSON from model output
 *
 * Other adapters (e.g., Anthropic Messages API) handle tool calls natively
 * and do not need this parsing logic.
 */

import { isRecordObject } from '../utilities';

import type { AgentLogger } from '../agent-logger';

// =============================================================================
// Function Call Format Normalization
// =============================================================================

/**
 * Normalize alternative function call formats to the canonical `<tool_use>` format.
 *
 * Models may emit tool calls in several non-canonical XML formats instead of `<tool_use>`.
 * This function normalizes all known variants:
 *
 * **Format A** (legacy — `<parameter name="name">` + `<parameter name="input">`):
 * ```xml
 * <function_calls><invoke>
 *   <parameter name="name">file_read</parameter>
 *   <parameter name="input">{"path": "/a.txt"}</parameter>
 * </invoke></function_calls>
 * ```
 *
 * **Format B** (`<invoke name="...">` with individual `<parameter>` elements):
 * ```xml
 * <function_calls><invoke name="file_read">
 *   <parameter name="path">/a.txt</parameter>
 * </invoke></function_calls>
 * ```
 * A single `<function_calls>` wrapper can contain multiple `<invoke>` blocks.
 */
export function normalizeFunctionCallsFormat(output: string): string {
	// Format A: <function_calls><invoke><parameter name="name">TOOL</parameter><parameter name="input">JSON</parameter></invoke></function_calls>
	let result = output.replaceAll(
		/<function_calls>\s*<invoke>\s*<parameter\s+name="name">([\s\S]*?)<\/parameter>\s*<parameter\s+name="input">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/g,
		(_match, name: string, inputJson: string) => {
			const toolName = name.trim();
			const input = inputJson.trim();
			return `<tool_use>\n{"name": ${JSON.stringify(toolName)}, "input": ${input}}\n</tool_use>`;
		},
	);

	// Format B: <function_calls><invoke name="tool">...<parameter name="key">value</parameter>...</invoke></function_calls>
	// A single <function_calls> block can contain multiple <invoke> elements.
	result = result.replaceAll(/<function_calls>([\s\S]*?)<\/function_calls>/g, (_match, innerContent: string) => {
		// Extract each <invoke name="...">...</invoke> block from the wrapper
		const invokePattern = /<invoke\s+name="([^"]*)">([\s\S]*?)<\/invoke>/g;
		let invokeMatch: RegExpExecArray | null;
		const toolUseBlocks: string[] = [];

		invokeMatch = invokePattern.exec(innerContent);
		while (invokeMatch !== null) {
			const toolName = invokeMatch[1].trim();
			const parametersBlock = invokeMatch[2];

			// Extract individual <parameter name="key">value</parameter> pairs
			const parameterPattern = /<parameter\s+name="([^"]*)">([\s\S]*?)<\/parameter>/g;
			let parameterMatch: RegExpExecArray | null;
			const input: Record<string, string> = {};

			parameterMatch = parameterPattern.exec(parametersBlock);
			while (parameterMatch !== null) {
				const key = parameterMatch[1].trim();
				const value = parameterMatch[2];
				if (key) {
					input[key] = value;
				}
				parameterMatch = parameterPattern.exec(parametersBlock);
			}

			if (toolName) {
				toolUseBlocks.push(`<tool_use>\n{"name": "${toolName}", "input": ${JSON.stringify(input)}}\n</tool_use>`);
			}
			invokeMatch = invokePattern.exec(innerContent);
		}

		// If we found invoke blocks, return them; otherwise return the original match unchanged
		return toolUseBlocks.length > 0 ? toolUseBlocks.join('\n') : _match;
	});

	return result;
}

// =============================================================================
// JSON Repair
// =============================================================================

/**
 * Parser states for the JSON repair state machine.
 * Inspired by the Vercel AI SDK's `fixJson` approach — a single-pass linear-time
 * scanner that tracks the last valid truncation point and can close open structures.
 */
type JsonParserState =
	| 'ROOT'
	| 'FINISH'
	| 'INSIDE_STRING'
	| 'INSIDE_STRING_ESCAPE'
	| 'INSIDE_NUMBER'
	| 'INSIDE_LITERAL'
	| 'INSIDE_OBJECT_START'
	| 'INSIDE_OBJECT_AFTER_KEY'
	| 'INSIDE_OBJECT_BEFORE_VALUE'
	| 'INSIDE_OBJECT_AFTER_VALUE'
	| 'INSIDE_OBJECT_AFTER_COMMA'
	| 'INSIDE_ARRAY_START'
	| 'INSIDE_ARRAY_AFTER_VALUE'
	| 'INSIDE_ARRAY_AFTER_COMMA';

/**
 * Attempt to repair malformed/truncated JSON from model output using a
 * stack-based state machine. This handles:
 * - Markdown code fences
 * - Trailing commas
 * - Unclosed strings, objects, arrays
 * - Incomplete literals (true/false/null → completed)
 * - Incomplete numbers (trailing dots stripped)
 * - Nested structures properly closed
 *
 * Returns the repaired JSON string, or undefined if unrecoverable.
 */
export function repairToolCallJson(raw: string): string | undefined {
	let s = raw.trim();

	// Strip markdown code fences
	s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

	// Fast path: already valid
	try {
		JSON.parse(s);
		return s;
	} catch {
		// Continue to repair
	}

	// Remove trailing commas before } or ] (common LLM mistake)
	s = s.replaceAll(/,\s*([}\]])/g, '$1');
	try {
		JSON.parse(s);
		return s;
	} catch {
		// Continue to state-machine repair
	}

	// State-machine repair: scan character by character, track last valid
	// truncation point, then close any open structures.
	const repaired = fixJson(s);
	if (repaired === undefined) {
		return undefined;
	}

	try {
		JSON.parse(repaired);
		return repaired;
	} catch {
		return undefined;
	}
}

/**
 * Fix truncated JSON by scanning with a state machine and closing open structures.
 * Adapted from the Vercel AI SDK's fixJson pattern.
 *
 * Two modes:
 * - **Conservative** (`mode: 'safe-truncate'`): Truncates to `lastValidIndex` —
 *   the last character where truncating produces valid JSON. Use for streaming
 *   partial-JSON preview (drops incomplete key-value pairs).
 * - **Aggressive** (`mode: 'repair'`): Keeps ALL scanned content and closes
 *   open structures from the current position. Use for post-stream tool call
 *   JSON recovery (preserves truncated strings, completes literals).
 */
function fixJson(input: string, mode: 'safe-truncate' | 'repair' = 'repair'): string | undefined {
	const stack: JsonParserState[] = ['ROOT'];
	let lastValidIndex = -1;
	let literalTarget = ''; // The full literal we're trying to match (e.g., "true", "false", "null")
	let literalIndex = 0; // How far into the literal we've matched

	function currentState(): JsonParserState {
		return stack.at(-1) ?? 'FINISH';
	}

	for (let index = 0; index < input.length; index++) {
		const character = input[index];
		const state = currentState();

		switch (state) {
			case 'ROOT':
			case 'INSIDE_OBJECT_BEFORE_VALUE':
			case 'INSIDE_ARRAY_START':
			case 'INSIDE_ARRAY_AFTER_COMMA': {
				// States expecting an arbitrary JSON value
				if (isWhitespace(character)) break;

				if (character === '"') {
					stack.pop();
					stack.push(swapStateAfterValue(state), 'INSIDE_STRING');
					break;
				}
				if (character === '{') {
					stack.pop();
					stack.push(swapStateAfterValue(state), 'INSIDE_OBJECT_START');
					break;
				}
				if (character === '[') {
					stack.pop();
					stack.push(swapStateAfterValue(state), 'INSIDE_ARRAY_START');
					break;
				}
				if (character === ']' && (state === 'INSIDE_ARRAY_START' || state === 'INSIDE_ARRAY_AFTER_COMMA')) {
					lastValidIndex = index;
					stack.pop();
					break;
				}
				if (character === 't' || character === 'f' || character === 'n') {
					stack.pop();
					stack.push(swapStateAfterValue(state), 'INSIDE_LITERAL');
					literalTarget = character === 't' ? 'true' : character === 'f' ? 'false' : 'null';
					literalIndex = 1;
					break;
				}
				if (character === '-' || isDigit(character)) {
					stack.pop();
					stack.push(swapStateAfterValue(state), 'INSIDE_NUMBER');
					break;
				}
				// Unexpected character — unrecoverable
				return undefined;
			}

			case 'INSIDE_STRING': {
				if (character === '\\') {
					stack.pop();
					stack.push('INSIDE_STRING_ESCAPE');
					break;
				}
				if (character === '"') {
					stack.pop();
					lastValidIndex = index;
					break;
				}
				// Any other character is valid inside a string
				break;
			}

			case 'INSIDE_STRING_ESCAPE': {
				// After a backslash, any character is consumed
				stack.pop();
				stack.push('INSIDE_STRING');
				break;
			}

			case 'INSIDE_NUMBER': {
				if (isDigit(character) || character === '.' || character === 'e' || character === 'E' || character === '+' || character === '-') {
					break; // Continue number
				}
				// Number ended — pop state and re-process this character
				stack.pop();
				lastValidIndex = index - 1;
				index--; // Re-process current character in parent state
				break;
			}

			case 'INSIDE_LITERAL': {
				if (literalIndex < literalTarget.length && character === literalTarget[literalIndex]) {
					literalIndex++;
					if (literalIndex === literalTarget.length) {
						stack.pop();
						lastValidIndex = index;
					}
					break;
				}
				// Literal didn't match — try to recover by treating it as finished
				stack.pop();
				lastValidIndex = index - 1;
				index--;
				break;
			}

			case 'INSIDE_OBJECT_START': {
				// Expecting either '}' (empty object) or a key string
				if (isWhitespace(character)) break;
				if (character === '}') {
					lastValidIndex = index;
					stack.pop();
					break;
				}
				if (character === '"') {
					stack.pop();
					stack.push('INSIDE_OBJECT_AFTER_KEY', 'INSIDE_STRING');
					break;
				}
				return undefined;
			}

			case 'INSIDE_OBJECT_AFTER_COMMA': {
				// After a comma in an object, expecting a key string
				if (isWhitespace(character)) break;
				if (character === '}') {
					// Trailing comma before } — be lenient
					lastValidIndex = index;
					stack.pop();
					break;
				}
				if (character === '"') {
					stack.pop();
					stack.push('INSIDE_OBJECT_AFTER_KEY', 'INSIDE_STRING');
					break;
				}
				return undefined;
			}

			case 'INSIDE_OBJECT_AFTER_KEY': {
				if (isWhitespace(character)) break;
				if (character === ':') {
					stack.pop();
					stack.push('INSIDE_OBJECT_BEFORE_VALUE');
					break;
				}
				return undefined;
			}

			case 'INSIDE_OBJECT_AFTER_VALUE': {
				if (isWhitespace(character)) break;
				if (character === ',') {
					stack.pop();
					stack.push('INSIDE_OBJECT_AFTER_COMMA');
					break;
				}
				if (character === '}') {
					lastValidIndex = index;
					stack.pop();
					break;
				}
				return undefined;
			}

			case 'INSIDE_ARRAY_AFTER_VALUE': {
				if (isWhitespace(character)) break;
				if (character === ',') {
					stack.pop();
					stack.push('INSIDE_ARRAY_AFTER_COMMA');
					break;
				}
				if (character === ']') {
					lastValidIndex = index;
					stack.pop();
					break;
				}
				return undefined;
			}

			case 'FINISH': {
				if (isWhitespace(character)) break;
				// Extra content after valid JSON — ignore it
				return input.slice(0, lastValidIndex + 1);
			}
		}
	}

	// Handle end-of-input number: if we ended while scanning a number,
	// pop the number state and accept everything up to here.
	if (currentState() === 'INSIDE_NUMBER') {
		stack.pop();
		// Strip trailing non-digit characters (e.g. "12." → "12")
		let numberEnd = input.length - 1;
		while (numberEnd >= 0 && !isDigit(input[numberEnd])) {
			numberEnd--;
		}
		lastValidIndex = numberEnd;
	}

	if (mode === 'repair') {
		// Aggressive: keep all scanned content, close open structures.
		// This preserves truncated strings and partial values.
		const closingCharacters = buildClosingCharacters(stack, literalTarget, literalIndex);
		const base = input;

		if (base.length === 0 && closingCharacters.length === 0) {
			return undefined;
		}
		return base + closingCharacters;
	}

	// Conservative (safe-truncate): truncate to last valid index, close structures.
	const truncated = input.slice(0, lastValidIndex + 1);
	const closingCharacters = buildClosingCharacters(stack, literalTarget, literalIndex);

	if (truncated.length === 0 && closingCharacters.length === 0) {
		return undefined;
	}

	return truncated + closingCharacters;
}

/**
 * Determine the "after value" state when swapping from a "before value" state.
 */
function swapStateAfterValue(state: JsonParserState): JsonParserState {
	switch (state) {
		case 'ROOT': {
			return 'FINISH';
		}
		case 'INSIDE_OBJECT_BEFORE_VALUE': {
			return 'INSIDE_OBJECT_AFTER_VALUE';
		}
		case 'INSIDE_ARRAY_START':
		case 'INSIDE_ARRAY_AFTER_COMMA': {
			return 'INSIDE_ARRAY_AFTER_VALUE';
		}
		default: {
			return 'FINISH';
		}
	}
}

/**
 * Build closing characters for any open structures remaining on the stack.
 *
 * Walks the stack from innermost to outermost and appends the appropriate
 * closing syntax for each open structure:
 * - Strings → `"`
 * - Objects → `}` (with special handling for incomplete key-value states)
 * - Arrays → `]`
 * - Literals → complete the remaining characters (e.g., `tru` → `true`)
 * - Numbers → no closer needed (already terminated)
 *
 * For incomplete object states (after-key without colon, before-value without
 * value), we emit `null` as a placeholder value to keep the JSON valid.
 */
function buildClosingCharacters(stack: JsonParserState[], literalTarget: string, literalIndex: number): string {
	let closing = '';

	for (let index = stack.length - 1; index >= 0; index--) {
		const state = stack[index];
		switch (state) {
			case 'INSIDE_STRING': {
				closing += '"';
				break;
			}
			case 'INSIDE_OBJECT_START':
			case 'INSIDE_OBJECT_AFTER_VALUE':
			case 'INSIDE_OBJECT_AFTER_COMMA': {
				closing += '}';
				break;
			}
			case 'INSIDE_OBJECT_AFTER_KEY': {
				// Have a key string but no colon/value yet — add `: null}` to form valid JSON
				closing += ': null}';
				break;
			}
			case 'INSIDE_OBJECT_BEFORE_VALUE': {
				// Have `key:` but no value — add `null}` as a placeholder
				closing += 'null}';
				break;
			}
			case 'INSIDE_ARRAY_START':
			case 'INSIDE_ARRAY_AFTER_VALUE': {
				closing += ']';
				break;
			}
			case 'INSIDE_ARRAY_AFTER_COMMA': {
				// Have a trailing comma — add `null]` to avoid `[1,]`
				closing += 'null]';
				break;
			}
			case 'INSIDE_LITERAL': {
				// Complete the literal
				closing += literalTarget.slice(literalIndex);
				break;
			}
			// INSIDE_NUMBER, INSIDE_STRING_ESCAPE, ROOT, FINISH — no closing needed
		}
	}

	return closing;
}

function isWhitespace(character: string): boolean {
	return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function isDigit(character: string): boolean {
	return character >= '0' && character <= '9';
}

// =============================================================================
// Tool Call Parsing
// =============================================================================

export interface ParsedToolCall {
	name: string;
	input: Record<string, string>;
}

/**
 * Parse result from tool call extraction. Following the Vercel AI SDK's
 * "never crash" pattern — parsing errors are reported but never thrown.
 */
interface ParseToolCallsResult {
	textParts: string[];
	toolCalls: ParsedToolCall[];
}

/**
 * Try to parse a JSON string, falling back to repair if needed.
 * Returns the parsed object or undefined if unrecoverable.
 */
function safeParseToolJson(jsonString: string): Record<string, unknown> | undefined {
	// Fast path: valid JSON
	try {
		const parsed: unknown = JSON.parse(jsonString);
		if (isRecordObject(parsed)) return parsed;
		return undefined;
	} catch {
		// Continue to repair
	}

	// Repair attempt
	const repaired = repairToolCallJson(jsonString);
	if (repaired === undefined) return undefined;

	try {
		const parsed: unknown = JSON.parse(repaired);
		if (isRecordObject(parsed)) return parsed;
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Extract the tool input from a parsed tool call object.
 * Handles three common LLM output patterns:
 *   1. Canonical: `{ "name": "...", "input": { ... } }`
 *   2. Flat: `{ "name": "...", "path": "...", "content": "..." }` (input at top level)
 *   3. Empty: `{ "name": "..." }` (no-argument tools like files_list)
 */
function extractToolInput(toolData: Record<string, unknown>): Record<string, unknown> {
	if (isRecordObject(toolData.input)) {
		return toolData.input;
	}

	// Flat format: everything except "name" and "input" is part of the input
	const { name: _name, input: _discardedInput, ...rest } = toolData;

	// If there are remaining keys, treat them as the input
	if (Object.keys(rest).length > 0) {
		return rest;
	}

	// No-argument tool — return empty object
	return {};
}

/**
 * Coerce tool input values to strings for the legacy tool executor interface.
 * Complex values (objects, arrays) are JSON-serialized rather than using
 * String() which would produce "[object Object]".
 */
function coerceInputToStrings(input: Record<string, unknown>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(input)) {
		if (typeof value === 'string') {
			result[key] = value;
		} else if (value === undefined) {
			result[key] = '';
		} else {
			// Numbers, booleans, objects, arrays — use JSON for lossless conversion
			result[key] = JSON.stringify(value);
		}
	}
	return result;
}

/**
 * Parse `<tool_use>` XML blocks from the model's text output.
 *
 * Follows the "never crash" pattern — any parsing errors for individual tool
 * blocks are logged and the block is treated as text rather than throwing.
 * This ensures the adapter always produces a valid result even with malformed
 * model output.
 *
 * Handles:
 * - Multiple tool_use blocks in a single response
 * - Text interleaved between tool blocks
 * - Incomplete/truncated closing tags (treated as text)
 * - Malformed JSON inside tool blocks (repair attempted, falls back to text)
 * - Empty tool names (filtered out with warning)
 */
export function parseToolCalls(output: string, logger?: AgentLogger): ParseToolCallsResult {
	const textParts: string[] = [];
	const toolCalls: ParsedToolCall[] = [];

	const openTag = '<tool_use>';
	const closeTag = '</tool_use>';
	let lastIndex = 0;
	let searchFrom = 0;

	logger?.debug('tool_parse', 'parse_start', { outputLength: output.length });

	try {
		while (searchFrom < output.length) {
			const tagStart = output.indexOf(openTag, searchFrom);
			if (tagStart === -1) break;

			const jsonStart = tagStart + openTag.length;
			const tagEnd = output.indexOf(closeTag, jsonStart);

			if (tagEnd === -1) {
				// Unclosed tool_use block — attempt to parse what we have (truncated output)
				const remainingJson = output.slice(jsonStart).trim();
				if (remainingJson) {
					// Capture text before the unclosed tag
					const textBefore = output.slice(lastIndex, tagStart).trim();
					if (textBefore) textParts.push(textBefore);

					const toolData = safeParseToolJson(remainingJson);
					if (toolData) {
						const toolName = typeof toolData.name === 'string' ? toolData.name.trim() : '';
						if (toolName) {
							const input = extractToolInput(toolData);
							toolCalls.push({ name: toolName, input: coerceInputToStrings(input) });
							logger?.info('tool_parse', 'truncated_block_recovered', {
								toolName,
								jsonLength: remainingJson.length,
							});
						} else {
							logger?.warn('tool_parse', 'empty_name_truncated', {
								jsonSnippet: remainingJson.slice(0, 200),
							});
							console.warn('Parsed tool call with empty name from truncated block, treating as text');
							textParts.push(output.slice(tagStart));
						}
					} else {
						logger?.warn('tool_parse', 'unrecoverable_truncated', {
							jsonSnippet: remainingJson.slice(0, 200),
						});
						// Unrecoverable — treat entire remaining output as text
						textParts.push(output.slice(tagStart));
					}
					lastIndex = output.length;
				}
				break;
			}

			const jsonString = output.slice(jsonStart, tagEnd).trim();
			const blockEnd = tagEnd + closeTag.length;

			// Capture text before this tool block
			const textBefore = output.slice(lastIndex, tagStart).trim();
			if (textBefore) {
				textParts.push(textBefore);
			}

			const toolData = safeParseToolJson(jsonString);
			if (toolData) {
				const toolName = typeof toolData.name === 'string' ? toolData.name.trim() : '';
				if (toolName) {
					const input = extractToolInput(toolData);
					toolCalls.push({ name: toolName, input: coerceInputToStrings(input) });
				} else {
					logger?.warn('tool_parse', 'empty_name', {
						jsonSnippet: jsonString.slice(0, 200),
					});
					console.warn('Parsed tool call with empty name, treating as text');
					textParts.push(output.slice(tagStart, blockEnd));
				}
			} else {
				logger?.warn('tool_parse', 'parse_error', {
					jsonSnippet: jsonString.slice(0, 200),
				});
				console.warn('Failed to parse tool use JSON, treating as text:', jsonString.slice(0, 200));
				textParts.push(output.slice(tagStart, blockEnd));
			}

			lastIndex = blockEnd;
			searchFrom = blockEnd;
		}
	} catch (error) {
		// Outer safety net — should never happen, but guarantees we never crash
		logger?.error('tool_parse', 'unexpected_error', {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		console.error('Unexpected error during tool call parsing:', error);
		// Return whatever we've collected so far, plus remaining text
		const remaining = output.slice(lastIndex).trim();
		if (remaining) textParts.push(remaining);
		return { textParts, toolCalls };
	}

	// Capture remaining text after last tool block
	const remainingText = output.slice(lastIndex).trim();
	if (remainingText) {
		textParts.push(remainingText);
	}

	return { textParts, toolCalls };
}
