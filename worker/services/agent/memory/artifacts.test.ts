import { describe, expect, it } from 'vitest';

import { buildDiagnosticsArtifactEntry, buildPlanArtifactEntry, buildSubAgentArtifactEntry, buildTodosArtifactEntry } from './artifacts';

describe('artifact builders', () => {
	it('builds a searchable plan artifact with session metadata', () => {
		const entry = buildPlanArtifactEntry('session-1', '# Plan\n\n- [x] Done\n- [ ] Next');

		expect(entry.key).toBe('plan:session-1');
		expect(entry.content).toContain('type: plan');
		expect(entry.content).toContain('session: session-1');
		expect(entry.content).toContain('Current implementation plan');
		expect(entry.content).toContain('1/2 checklist items completed');
	});

	it('builds a todo artifact summary with counts', () => {
		const entry = buildTodosArtifactEntry('session-2', [
			{ id: '1', content: 'Read code', status: 'completed', priority: 'high' },
			{ id: '2', content: 'Write tests', status: 'in_progress', priority: 'medium' },
		]);

		expect(entry.key).toBe('todos:session-2');
		expect(entry.content).toContain('type: todos');
		expect(entry.content).toContain('2 todos with 1 completed, 1 in progress, and 0 pending');
		expect(entry.content).toContain('- [x] (high) Read code');
		expect(entry.content).toContain('- [~] (medium) Write tests');
	});

	it('truncates diagnostics artifacts from the start so recent logs survive', () => {
		const noisyDiagnostics = `${'old\n'.repeat(4000)}recent failure`;
		const entry = buildDiagnosticsArtifactEntry('session-3', noisyDiagnostics, 'post-change');

		expect(entry.key).toBe('diagnostics:session-3:post-change');
		expect(entry.content).toContain('type: diagnostics');
		expect(entry.content).toContain('source: post-change');
		expect(entry.content).toContain('... (older content truncated)');
		expect(entry.content).toContain('recent failure');
	});

	it('builds sub-agent reports with delegated task context', () => {
		const entry = buildSubAgentArtifactEntry({
			sessionId: 'session-4',
			toolCallId: 'tool-123',
			prompt: 'Inspect the failing route',
			additionalContext: 'Focus on worker/index.ts',
			resultText: 'The route is missing auth middleware.',
			iterations: 2,
		});

		expect(entry.key).toBe('sub-agent:session-4:tool-123');
		expect(entry.content).toContain('type: sub-agent');
		expect(entry.content).toContain('Focused delegated run completed in 2 turns');
		expect(entry.content).toContain('Inspect the failing route');
		expect(entry.content).toContain('Focus on worker/index.ts');
		expect(entry.content).toContain('The route is missing auth middleware.');
	});
});
