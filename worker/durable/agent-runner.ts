/**
 * Agent Runner Durable Object.
 *
 * Executes AI agent loops independently of client connections. This enables:
 * - Session generation continues even if the user disconnects
 * - Collaboration users can observe ongoing agent sessions in real-time
 * - Explicit abort via WebSocket message or RPC
 *
 * One instance per project, keyed by `agent:${projectId}`.
 * Communicates with ProjectCoordinator (for event broadcast) and
 * ExpiringFilesystem (for file operations) via RPC — no self-referential calls.
 */

import { convertMessagesToModelMessages } from '@tanstack/ai';
import { DurableObject, env } from 'cloudflare:workers';
import { mount, withMounts } from 'worker-fs-mount';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { AIAgentService } from '../services/ai-agent';

import type { AIModelId } from '@shared/constants';
import type { ActiveAgentSession, AgentSessionStatus } from '@shared/types';

/**
 * Storage keys used by the synchronous KV API (`ctx.storage.kv`).
 */
const STORAGE_KEY = {
	/** Active agent session state (serialized ActiveAgentSession or undefined). */
	ACTIVE_SESSION: 'activeAgentSession',
} as const;

/**
 * Maximum number of recent stream events to buffer for reconnection.
 * Late-joining clients receive these events to catch up.
 */
const EVENT_BUFFER_CAPACITY = 500;

/**
 * Project root path used by the filesystem mount.
 */
const PROJECT_ROOT = '/project';

/**
 * Parameters for starting an agent run.
 */
export interface StartAgentParameters {
	messages: unknown[];
	mode?: 'code' | 'plan' | 'ask';
	sessionId?: string;
	model?: string;
	outputLogs?: string;
}

export class AgentRunner extends DurableObject {
	/**
	 * In-memory abort controller for the currently running agent.
	 * Not serializable — if the DO is evicted mid-run, the agent loop
	 * terminates naturally and the session is persisted.
	 */
	private agentAbortController: AbortController | undefined;

	/**
	 * Ring buffer of recent stream events for late-joining clients.
	 * Cleared when the agent run completes.
	 */
	private eventBuffer: Array<{ chunk: unknown; index: number }> = [];

	/**
	 * Monotonic event index within the current agent run.
	 */
	private eventIndex = 0;

	/**
	 * The project ID, derived from the DO name.
	 */
	private get projectId(): string {
		const name = this.ctx.id.name;
		if (!name) throw new Error('AgentRunner DO must be created with idFromName');
		// Keyed as "agent:{projectId}" — strip the prefix
		return name.startsWith('agent:') ? name.slice(6) : name;
	}

	// =========================================================================
	// RPC Methods
	// =========================================================================

	/**
	 * Start an AI agent run. Returns immediately with the session state.
	 * The agent loop continues running asynchronously within the DO.
	 *
	 * If an agent is already running, returns the existing session state
	 * without starting a new one.
	 */
	async startAgent(parameters: StartAgentParameters): Promise<ActiveAgentSession> {
		const existing = this.getActiveSession();
		if (existing?.status === 'running') {
			return existing;
		}

		const sessionId = parameters.sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
		const session: ActiveAgentSession = {
			sessionId,
			status: 'running',
			startedAt: Date.now(),
		};
		this.setActiveSession(session);

		// Reset event buffer for the new run
		this.eventBuffer = [];
		this.eventIndex = 0;

		// Create a new abort controller for this run
		this.agentAbortController = new AbortController();

		// Start the agent loop asynchronously — does not block the RPC response.
		// The DO stays alive as long as this async work is in progress.
		this.ctx.waitUntil(this.executeAgentLoop(parameters, sessionId));

		// Broadcast the status change to all connected clients
		await this.broadcastStatusChanged(sessionId, 'running');

		return session;
	}

	/**
	 * Abort the currently running agent. No-op if no agent is running.
	 */
	async abortAgent(): Promise<void> {
		if (this.agentAbortController) {
			this.agentAbortController.abort();
		}
	}

	/**
	 * Get the current agent session state.
	 */
	async getAgentStatus(): Promise<ActiveAgentSession | undefined> {
		return this.getActiveSession();
	}

	/**
	 * Get buffered events since a given index for reconnection.
	 * Returns events with index > lastEventIndex.
	 */
	async getBufferedEvents(lastEventIndex: number): Promise<Array<{ chunk: unknown; index: number }>> {
		return this.eventBuffer.filter((event) => event.index > lastEventIndex);
	}

	// =========================================================================
	// Agent Loop Execution
	// =========================================================================

	private async executeAgentLoop(parameters: StartAgentParameters, sessionId: string): Promise<void> {
		const projectId = this.projectId;
		let finalStatus: AgentSessionStatus = 'completed';

		try {
			const apiToken = env.REPLICATE_API_TOKEN;
			if (!apiToken) {
				throw new Error('REPLICATE_API_TOKEN not configured');
			}

			// Get the filesystem stub for this project
			const fsId = filesystemNamespace.idFromString(projectId);
			const fsStub = filesystemNamespace.get(fsId);

			const mode = parameters.mode ?? 'code';
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- model ID validated upstream
			const model = (parameters.model ?? DEFAULT_AI_MODEL) as AIModelId;

			// Convert UIMessage[] to ModelMessage[]
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- UIMessage format from frontend is loosely typed at the wire boundary
			const modelMessages = convertMessagesToModelMessages(parameters.messages as any);

			const agentService = new AIAgentService(PROJECT_ROOT, projectId, fsStub, sessionId, mode, model);

			// Run the agent stream within a filesystem mount scope
			const stream = withMounts(() => {
				mount(PROJECT_ROOT, fsStub);
				const abortController = this.agentAbortController ?? new AbortController();
				return agentService.runAgentStream(modelMessages, parameters.messages, apiToken, abortController, parameters.outputLogs);
			});

			// Get the coordinator stub for broadcasting events
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);

			// Consume the stream and broadcast each chunk
			for await (const chunk of stream) {
				const index = this.eventIndex++;

				// Buffer the event for late-joining clients
				this.eventBuffer.push({ chunk, index });
				if (this.eventBuffer.length > EVENT_BUFFER_CAPACITY) {
					this.eventBuffer.shift();
				}

				// Broadcast to all connected WebSocket clients via the coordinator
				try {
					await coordinatorStub.sendMessage({
						type: 'agent-stream-event',
						sessionId,
						chunk,
						index,
					});
				} catch {
					// Non-fatal: if the coordinator is unavailable, the event
					// is still buffered for reconnection
				}
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				finalStatus = 'aborted';
			} else {
				finalStatus = 'error';
				console.error('Agent loop error in AgentRunner DO:', error);
			}
		} finally {
			// Update the session status
			const session = this.getActiveSession();
			if (session) {
				session.status = finalStatus;
				this.setActiveSession(session);
			}

			// Clean up
			this.agentAbortController = undefined;

			// Broadcast the final status
			await this.broadcastStatusChanged(sessionId, finalStatus).catch(() => {});
		}
	}

	// =========================================================================
	// Status Broadcasting
	// =========================================================================

	private async broadcastStatusChanged(sessionId: string, status: AgentSessionStatus, title?: string): Promise<void> {
		try {
			const coordinatorId = coordinatorNamespace.idFromName(`project:${this.projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
			await coordinatorStub.sendMessage({
				type: 'agent-status-changed',
				sessionId,
				status,
				title,
			});
		} catch {
			// Non-fatal
		}
	}

	// =========================================================================
	// Storage Helpers
	// =========================================================================

	private getActiveSession(): ActiveAgentSession | undefined {
		return this.ctx.storage.kv.get<ActiveAgentSession>(STORAGE_KEY.ACTIVE_SESSION);
	}

	private setActiveSession(session: ActiveAgentSession | undefined): void {
		if (session === undefined) {
			this.ctx.storage.kv.delete(STORAGE_KEY.ACTIVE_SESSION);
		} else {
			this.ctx.storage.kv.put(STORAGE_KEY.ACTIVE_SESSION, session);
		}
	}
}
