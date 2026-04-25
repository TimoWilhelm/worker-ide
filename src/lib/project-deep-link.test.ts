import { describe, expect, it, vi } from 'vitest';

import { applyProjectDeepLink } from './project-deep-link';

describe('applyProjectDeepLink', () => {
	it('routes agent session deep links through the shared session action', () => {
		const actions = {
			openFileTarget: vi.fn(),
			requestAgentSession: vi.fn(),
			setActiveMobilePanel: vi.fn(),
			showAgentPanel: vi.fn(),
		};

		applyProjectDeepLink({ kind: 'agent-session', sessionId: 'session-2' }, actions);

		expect(actions.requestAgentSession).toHaveBeenCalledWith('session-2');
		expect(actions.openFileTarget).not.toHaveBeenCalled();
	});

	it('routes file deep links through the shared file opener', () => {
		const actions = {
			openFileTarget: vi.fn(),
			requestAgentSession: vi.fn(),
			setActiveMobilePanel: vi.fn(),
			showAgentPanel: vi.fn(),
		};

		applyProjectDeepLink({ kind: 'file', file: { path: '/src/app.ts', line: 4 } }, actions);

		expect(actions.openFileTarget).toHaveBeenCalledWith({
			path: '/src/app.ts',
			position: { line: 4, column: 1 },
		});
	});

	it('switches mobile panels for non-agent panel deep links', () => {
		const actions = {
			openFileTarget: vi.fn(),
			requestAgentSession: vi.fn(),
			setActiveMobilePanel: vi.fn(),
			showAgentPanel: vi.fn(),
		};

		applyProjectDeepLink({ kind: 'panel', panel: 'preview' }, actions);

		expect(actions.setActiveMobilePanel).toHaveBeenCalledWith('preview');
	});

	it('shows the agent panel for panel-only agent deep links', () => {
		const actions = {
			openFileTarget: vi.fn(),
			requestAgentSession: vi.fn(),
			setActiveMobilePanel: vi.fn(),
			showAgentPanel: vi.fn(),
		};

		applyProjectDeepLink({ kind: 'panel', panel: 'agent' }, actions);

		expect(actions.showAgentPanel).toHaveBeenCalledTimes(1);
	});
});
