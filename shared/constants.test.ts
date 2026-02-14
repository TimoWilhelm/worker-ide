/**
 * Unit tests for shared constants.
 */

import { describe, expect, it } from 'vitest';

import { PLAN_MODE_SYSTEM_PROMPT, AGENTS_MD_MAX_CHARACTERS, MCP_SERVERS, HIDDEN_ENTRIES } from './constants';

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
