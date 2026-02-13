/**
 * Unit tests for shared constants.
 */

import { describe, expect, it } from 'vitest';

import { AGENT_TOOLS, PLAN_MODE_TOOLS, PLAN_MODE_SYSTEM_PROMPT, AGENTS_MD_MAX_CHARACTERS, MCP_SERVERS, HIDDEN_ENTRIES } from './constants';

// =============================================================================
// PLAN_MODE_TOOLS
// =============================================================================

describe('PLAN_MODE_TOOLS', () => {
	it('only includes read-only and research tools', () => {
		const toolNames = PLAN_MODE_TOOLS.map((tool) => tool.name);
		expect(toolNames).toContain('list_files');
		expect(toolNames).toContain('read_file');
		expect(toolNames).toContain('search_cloudflare_docs');
		expect(toolNames).toContain('get_todos');
		expect(toolNames).toContain('update_todos');
	});

	it('excludes file-editing tools', () => {
		const toolNames = PLAN_MODE_TOOLS.map((tool) => tool.name);
		expect(toolNames).not.toContain('write_file');
		expect(toolNames).not.toContain('delete_file');
		expect(toolNames).not.toContain('move_file');
	});

	it('is a subset of AGENT_TOOLS', () => {
		const agentToolNames = new Set(AGENT_TOOLS.map((tool) => tool.name));
		for (const tool of PLAN_MODE_TOOLS) {
			expect(agentToolNames.has(tool.name)).toBe(true);
		}
	});
});

// =============================================================================
// PLAN_MODE_SYSTEM_PROMPT
// =============================================================================

describe('PLAN_MODE_SYSTEM_PROMPT', () => {
	it('instructs the agent about read-only mode', () => {
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain('PLAN MODE');
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain('CANNOT');
	});

	it('mentions producing a plan', () => {
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain('plan');
	});
});

// =============================================================================
// AGENTS_MD_MAX_CHARACTERS
// =============================================================================

describe('AGENTS_MD_MAX_CHARACTERS', () => {
	it('is a positive number', () => {
		expect(AGENTS_MD_MAX_CHARACTERS).toBeGreaterThan(0);
	});

	it('is 16000', () => {
		expect(AGENTS_MD_MAX_CHARACTERS).toBe(16_000);
	});
});

// =============================================================================
// MCP_SERVERS
// =============================================================================

describe('MCP_SERVERS', () => {
	it('includes the Cloudflare docs server', () => {
		const cloudflareDocumentation = MCP_SERVERS.find((server) => server.id === 'cloudflare-docs');
		expect(cloudflareDocumentation).toBeDefined();
		expect(cloudflareDocumentation?.endpoint).toContain('cloudflare.com');
	});

	it('each server has id, name, and endpoint', () => {
		for (const server of MCP_SERVERS) {
			expect(server.id).toBeTruthy();
			expect(server.name).toBeTruthy();
			expect(server.endpoint).toMatch(/^https?:\/\//);
		}
	});
});

// =============================================================================
// HIDDEN_ENTRIES
// =============================================================================

describe('HIDDEN_ENTRIES', () => {
	it('includes .agent directory', () => {
		expect(HIDDEN_ENTRIES.has('.agent')).toBe(true);
	});

	it('includes .snapshots directory', () => {
		expect(HIDDEN_ENTRIES.has('.snapshots')).toBe(true);
	});
});
