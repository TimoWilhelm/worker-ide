/**
 * Unit tests for tool definitions and plan mode filtering.
 */

import { describe, expect, it } from 'vitest';

import { AGENT_TOOLS, ASK_MODE_TOOLS, PLAN_MODE_TOOLS } from './index';

// =============================================================================
// PLAN_MODE_TOOLS
// =============================================================================

describe('PLAN_MODE_TOOLS', () => {
	it('only includes read-only and research tools', () => {
		const toolNames = PLAN_MODE_TOOLS.map((tool) => tool.name);
		expect(toolNames).toContain('file_read');
		expect(toolNames).toContain('file_grep');
		expect(toolNames).toContain('file_glob');
		expect(toolNames).toContain('file_list');
		expect(toolNames).toContain('files_list');
		expect(toolNames).toContain('docs_search');
		expect(toolNames).toContain('web_fetch');
		expect(toolNames).toContain('user_question');
		expect(toolNames).toContain('todos_get');
		expect(toolNames).toContain('todos_update');
	});

	it('excludes file-editing tools', () => {
		const toolNames = PLAN_MODE_TOOLS.map((tool) => tool.name);
		expect(toolNames).not.toContain('file_edit');
		expect(toolNames).not.toContain('file_write');
		expect(toolNames).not.toContain('file_patch');
		expect(toolNames).not.toContain('file_delete');
		expect(toolNames).not.toContain('file_move');
	});

	it('is a subset of AGENT_TOOLS', () => {
		const agentToolNames = new Set(AGENT_TOOLS.map((tool) => tool.name));
		for (const tool of PLAN_MODE_TOOLS) {
			expect(agentToolNames.has(tool.name)).toBe(true);
		}
	});
});

// =============================================================================
// ASK_MODE_TOOLS
// =============================================================================

describe('ASK_MODE_TOOLS', () => {
	it('has no tools (conversational only)', () => {
		expect(ASK_MODE_TOOLS).toHaveLength(0);
	});
});

// =============================================================================
// AGENT_TOOLS
// =============================================================================

describe('AGENT_TOOLS', () => {
	it('every tool has name, description, and input_schema', () => {
		for (const tool of AGENT_TOOLS) {
			expect(tool.name).toBeTruthy();
			expect(tool.description).toBeTruthy();
			expect(tool.input_schema).toBeDefined();
			expect(tool.input_schema.type).toBe('object');
		}
	});

	it('has no duplicate tool names', () => {
		const names = AGENT_TOOLS.map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

// =============================================================================
// MUTATION_TOOL_NAMES / READ_ONLY_TOOL_NAMES
// =============================================================================

describe('MUTATION_TOOL_NAMES', () => {
	it('has no overlap with READ_ONLY_TOOL_NAMES', () => {
		for (const name of MUTATION_TOOL_NAMES) {
			expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(false);
		}
	});
});
