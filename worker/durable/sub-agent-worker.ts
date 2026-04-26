import { Agent } from 'agents';
import { Session } from 'agents/experimental/memory/session';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';
import { AIAgentService } from '../services/ai-agent';
import { chatMessagesToModelMessages } from '../services/ai-agent/context-pruner';

import type { AIModelId } from '@shared/constants';
import type { ChatMessage } from '@shared/types';

export interface SubAgentState {
	status: 'idle' | 'running' | 'completed' | 'error';
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
		this.setState({ status: 'running' });
		this.abortController = new AbortController();

		const fsId = toDurableObjectId(filesystemNamespace, projectId);
		const fsStub = filesystemNamespace.get(fsId);
		const service = new AIAgentService({
			projectRoot: '/project',
			projectId,
			fsStub,
			sessionId: `${this.name}-session`,
			mode: 'code',
			model,
			session: this.session,
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

			this.setState({ status: 'completed' });
			await service.flushLogger().catch(() => {});
			return {
				text: lastAssistantText.trim() || '(Sub-agent completed without producing text output)',
				iterations,
				debugLogId: service.getLogger()?.id,
			};
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
			this.session.clearMessages();
		}
	}

	async abort(): Promise<void> {
		this.abortController?.abort();
	}
}
