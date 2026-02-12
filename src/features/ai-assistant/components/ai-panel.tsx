/**
 * AI Assistant Panel Component
 *
 * Chat interface for interacting with the AI coding assistant.
 */

import { Bot, ChevronDown, Loader2, Send, Trash2, User } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { startAIChat, type AIStreamEvent } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { cn, formatRelativeTime } from '@/lib/utils';

import type { AgentContent, AgentMessage, ToolName } from '@shared/types';

// =============================================================================
// Helper functions
// =============================================================================

const VALID_TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>(['list_files', 'read_file', 'write_file', 'delete_file', 'move_file']);

function isToolName(value: unknown): value is ToolName {
	return typeof value === 'string' && VALID_TOOL_NAMES.has(value);
}

function getEventStringField(event: AIStreamEvent, field: string): string {
	const value = event[field];
	return typeof value === 'string' ? value : '';
}

function getEventToolName(event: AIStreamEvent, field: string): ToolName {
	const value = event[field];
	if (isToolName(value)) {
		return value;
	}
	return 'list_files';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getEventObjectField(event: AIStreamEvent, field: string): Record<string, unknown> {
	const value = event[field];
	return isRecord(value) ? value : {};
}

function getEventBooleanField(event: AIStreamEvent, field: string): boolean | undefined {
	const value = event[field];
	return typeof value === 'boolean' ? value : undefined;
}

// =============================================================================
// Component
// =============================================================================

/**
 * AI assistant panel with chat interface.
 */
export function AIPanel({ projectId, className }: { projectId: string; className?: string }) {
	const [input, setInput] = useState('');
	const inputReference = useRef<HTMLTextAreaElement>(null);
	const scrollReference = useRef<HTMLDivElement>(null);
	const abortControllerReference = useRef<AbortController | undefined>(undefined);

	// Store state
	const {
		history,
		isProcessing,
		statusMessage,
		savedSessions,
		sessionId,
		addMessage,
		clearHistory,
		loadSession,
		setProcessing,
		setStatusMessage,
	} = useStore();

	// Auto-scroll to bottom
	useEffect(() => {
		if (scrollReference.current) {
			scrollReference.current.scrollTop = scrollReference.current.scrollHeight;
		}
	}, [history, statusMessage]);

	// Focus input on mount
	useEffect(() => {
		inputReference.current?.focus();
	}, []);

	// Send message
	const handleSend = useCallback(async () => {
		if (!input.trim() || isProcessing) return;

		const userMessage: AgentMessage = {
			role: 'user',
			content: [{ type: 'text', text: input.trim() }],
		};

		addMessage(userMessage);
		setInput('');
		setProcessing(true);
		setStatusMessage('Thinking...');

		// Create abort controller for cancellation
		abortControllerReference.current = new AbortController();

		const assistantContent: AgentContent[] = [];

		try {
			// Convert history to API format
			const apiHistory = history.map((message) => ({
				role: message.role,
				content: message.content,
			}));

			await startAIChat(projectId, input.trim(), apiHistory, abortControllerReference.current.signal, (event: AIStreamEvent) => {
				switch (event.type) {
					case 'content_block_start': {
						// New content block starting
						break;
					}
					case 'content_block_delta': {
						if (event.delta && typeof event.delta === 'object' && 'text' in event.delta) {
							const delta = event.delta;
							const textValue = 'text' in delta ? delta.text : undefined;
							const deltaText = typeof textValue === 'string' ? textValue : '';
							// Accumulate text
							const lastContent = assistantContent.at(-1);
							if (lastContent && lastContent.type === 'text') {
								lastContent.text += deltaText;
							} else {
								assistantContent.push({ type: 'text', text: deltaText });
							}
							setStatusMessage(undefined);
						}
						break;
					}
					case 'tool_use': {
						// Tool being used
						const toolName = getEventToolName(event, 'name');
						setStatusMessage(`Using tool: ${toolName}`);
						assistantContent.push({
							type: 'tool_use',
							id: getEventStringField(event, 'id'),
							name: toolName,
							input: getEventObjectField(event, 'input'),
						});
						break;
					}
					case 'tool_result': {
						assistantContent.push({
							type: 'tool_result',
							tool_use_id: getEventStringField(event, 'tool_use_id'),
							content: getEventStringField(event, 'content'),
							is_error: getEventBooleanField(event, 'is_error'),
						});
						break;
					}
					case 'message_stop': {
						// Message complete
						break;
					}
					case 'error': {
						console.error('AI error:', event);
						break;
					}
				}
			});

			// Add complete assistant message
			if (assistantContent.length > 0) {
				addMessage({
					role: 'assistant',
					content: assistantContent,
				});
			}
		} catch (error: unknown) {
			if (error instanceof Error && error.name !== 'AbortError') {
				console.error('AI chat error:', error);
				addMessage({
					role: 'assistant',
					content: [{ type: 'text', text: `Error: ${error.message}` }],
				});
			}
		} finally {
			setProcessing(false);
			setStatusMessage(undefined);
			abortControllerReference.current = undefined;
		}
	}, [input, isProcessing, history, projectId, addMessage, setProcessing, setStatusMessage]);

	// Handle keyboard shortcuts
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void handleSend();
			}
		},
		[handleSend],
	);

	// Cancel current request
	const handleCancel = useCallback(() => {
		abortControllerReference.current?.abort();
	}, []);

	return (
		<div className={cn('flex h-full flex-col bg-bg-secondary', className)}>
			{/* Header */}
			<div
				className="
					flex h-10 shrink-0 items-center justify-between border-b border-border px-3
				"
			>
				<div className="flex items-center gap-2">
					<Bot className="size-4 text-accent" />
					<span className="text-sm font-medium text-text-primary">AI Assistant</span>
				</div>
				<div className="flex items-center gap-1">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
								<ChevronDown className="size-3" />
								Sessions
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuLabel>Saved Sessions</DropdownMenuLabel>
							<DropdownMenuSeparator />
							{savedSessions.length === 0 ? (
								<div className="px-2 py-1.5 text-xs text-text-secondary">No saved sessions</div>
							) : (
								savedSessions.map((session) => (
									<DropdownMenuItem
										key={session.id}
										onSelect={() => loadSession([], session.id)}
										className={cn(sessionId === session.id && 'bg-bg-tertiary')}
									>
										<div className="flex flex-col">
											<span className="text-sm">{session.label}</span>
											<span className="text-xs text-text-secondary">{formatRelativeTime(session.createdAt)}</span>
										</div>
									</DropdownMenuItem>
								))
							)}
						</DropdownMenuContent>
					</DropdownMenu>
					<Tooltip content="Clear history">
						<Button variant="ghost" size="icon" className="size-7" onClick={clearHistory}>
							<Trash2 className="size-3.5" />
						</Button>
					</Tooltip>
				</div>
			</div>

			{/* Messages */}
			<ScrollArea.Root className="flex-1 overflow-hidden">
				<ScrollArea.Viewport ref={scrollReference} className="size-full">
					<div className="flex flex-col gap-4 p-4">
						{history.length === 0 ? (
							<div
								className={`
									flex flex-col items-center justify-center py-8 text-center
									text-text-secondary
								`}
							>
								<Bot className="mb-2 size-8" />
								<p className="text-sm">Ask me to help with your code!</p>
								<p className="mt-1 text-xs">I can read, write, and modify files.</p>
							</div>
						) : (
							history.map((message, index) => <MessageBubble key={index} message={message} />)
						)}
						{statusMessage ? (
							<div className="flex items-center gap-2 text-xs text-text-secondary">
								<Loader2 className="size-3 animate-spin" />
								{statusMessage}
							</div>
						) : undefined}
					</div>
				</ScrollArea.Viewport>
				<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
					<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
				</ScrollArea.Scrollbar>
			</ScrollArea.Root>

			{/* Input */}
			<div className="shrink-0 border-t border-border p-3">
				<div className="flex gap-2">
					<textarea
						ref={inputReference}
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Ask a question or describe a task..."
						className={`
							flex-1 resize-none rounded-sm border border-border bg-bg-tertiary px-3
							py-2 text-sm text-text-primary
							placeholder:text-text-secondary
							focus:border-accent focus:outline-none
						`}
						rows={2}
						disabled={isProcessing}
					/>
					{isProcessing ? (
						<Tooltip content="Cancel">
							<Button variant="secondary" size="icon" onClick={handleCancel}>
								<Loader2 className="size-4 animate-spin" />
							</Button>
						</Tooltip>
					) : (
						<Tooltip content="Send">
							<Button variant="default" size="icon" onClick={() => void handleSend()} disabled={!input.trim()}>
								<Send className="size-4" />
							</Button>
						</Tooltip>
					)}
				</div>
			</div>
		</div>
	);
}

// =============================================================================
// Sub-components
// =============================================================================

function MessageBubble({ message }: { message: AgentMessage }) {
	const isUser = message.role === 'user';

	return (
		<div className={cn('flex gap-2', isUser && 'flex-row-reverse')}>
			<div className={cn('flex size-7 shrink-0 items-center justify-center rounded-full', isUser ? 'bg-accent' : 'bg-bg-tertiary')}>
				{isUser ? <User className="size-4 text-white" /> : <Bot className="size-4 text-text-secondary" />}
			</div>
			<div className={cn('flex max-w-[80%] flex-col gap-1 rounded-lg px-3 py-2', isUser ? 'bg-accent text-white' : 'bg-bg-tertiary')}>
				{message.content.map((contentBlock, index) => (
					<ContentBlock key={index} content={contentBlock} />
				))}
			</div>
		</div>
	);
}

function ContentBlock({ content }: { content: AgentContent }) {
	if (content.type === 'text') {
		return <p className="text-sm whitespace-pre-wrap">{content.text}</p>;
	}

	if (content.type === 'tool_use') {
		return (
			<div className="rounded-sm border border-border bg-bg-secondary/50 p-2 text-xs">
				<span className="font-medium text-accent">Tool: {content.name}</span>
				<pre className="mt-1 overflow-auto text-text-secondary">{JSON.stringify(content.input, undefined, 2)}</pre>
			</div>
		);
	}

	if (content.type === 'tool_result') {
		return (
			<div
				className={cn('rounded-sm border p-2 text-xs', content.is_error ? 'border-error bg-error/10' : 'border-border bg-bg-secondary/50')}
			>
				<span className="font-medium">Result:</span>
				<pre className="mt-1 overflow-auto text-text-secondary">{content.content}</pre>
			</div>
		);
	}

	return;
}
