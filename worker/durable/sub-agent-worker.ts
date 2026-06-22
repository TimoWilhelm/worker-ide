import { Agent } from 'agents';
import { Session } from 'agents/experimental/memory/session';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';
import { AgentService } from '../services/agent';
import { chatMessagesToModelMessages } from '../services/agent/context-pruner';

import type { AIModelId } from '@shared/constants';
import type { ChatMessage } from '@shared/types';

export interface SubAgentState {
	status: 'idle' | 'running' | 'completed' | 'error';
	/**
	 * Cached result of the last completed task. Lets a recovered parent run
	 * re-attach to this sub-agent (same deterministic name) and retrieve the
	 * result instead of re-running the delegated work.
	 */
	result?: SubAgentResult;
}

export interface SubAgentResult {
	text: string;
	iterations: number;
	debugLogId: string | undefined;
}

interface StreamCallback {
	pushEvent(eventJson: string): Promise<void>;
}

export class SubAgentWorker extends Agent<Env, SubAgentState> {
	initialState: SubAgentState = { status: 'idle' };
	private abortController?: AbortController;
	private session = Session.create(this).withContext('soul', {
		provider: {
			get: async () => 'You are a focused sub-agent. Complete the delegated task efficiently and report concise results.',
		},
	});

	async executeTask(
		projectId: string,
		messages: ChatMessage[],
		model: AIModelId = DEFAULT_AI_MODEL,
		callback?: StreamCallback,
		userId?: string,
		organizationId?: string,
	): Promise<SubAgentResult> {
		// Re-attach: if this sub-agent already completed (parent run was recovered
		// and re-issued the same deterministic call), return the cached result
		// instead of redoing the delegated work.
		if (this.state.status === 'completed' && this.state.result) {
			return this.state.result;
		}

		this.setState({ status: 'running', result: undefined });
		this.abortController = new AbortController();

		const fsId = toDurableObjectId(filesystemNamespace, projectId);
		const fsStub = filesystemNamespace.get(fsId);
		const service = new AgentService({
			projectRoot: '/project',
			projectId,
			fsStub,
			sessionId: `${this.name}-session`,
			mode: 'code',
			model,
			session: this.session,
			ctx: this.ctx,
			loader: this.env.LOADER,
			browser: this.env.BROWSER,
			agentReference: this,
			organizationId,
			initiatorUserId: userId,
		});

		let lastAssistantText = '';
		let iterations = 0;

		try {
			const stream = service.runAgentStream(chatMessagesToModelMessages(messages), messages, this.abortController);

			for await (const event of stream) {
				if (event.type === 'text-delta') {
					lastAssistantText += event.delta;
				}
				if (event.type === 'turn-complete') {
					iterations += 1;
				}
				if (callback) {
					await callback.pushEvent(JSON.stringify(event));
				}
			}

			const completedResult: SubAgentResult = {
				text: lastAssistantText.trim() || '(Sub-agent completed without producing text output)',
				iterations,
				debugLogId: service.getLogger()?.id,
			};
			this.setState({ status: 'completed', result: completedResult });
			await service.flushLogger().catch(() => {});
			return completedResult;
		} catch (error) {
			this.setState({ status: 'error' });
			if (error instanceof Error && error.name === 'AbortError') {
				return {
					text: lastAssistantText.trim() || '(Sub-agent aborted)',
					iterations,
					debugLogId: service.getLogger()?.id,
				};
			}
			throw error;
		} finally {
			this.abortController = undefined;
			await this.session.clearMessages();
		}
	}

	async abort(): Promise<void> {
		this.abortController?.abort();
	}
}
