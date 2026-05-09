import { previewElementToPromptText } from '@shared/preview-element';

import type { ChatMessage, MessagePart } from '@shared/types';
import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session';

export function chatMessageToSessionMessage(message: ChatMessage): SessionMessage {
	return {
		id: message.id,
		role: message.role,
		parts: message.parts.map((part) => messagePartToSessionPart(part)),
		createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
	};
}

function sessionMessageToChatMessage(message: SessionMessage): ChatMessage {
	return {
		id: message.id,
		role: message.role === 'user' ? 'user' : 'assistant',
		parts: message.parts.map((part) => sessionPartToMessagePart(part)),
		createdAt: message.createdAt ? new Date(message.createdAt).getTime() : undefined,
	};
}

export function sessionMessagesToChatMessages(messages: SessionMessage[]): ChatMessage[] {
	return messages.map((message) => sessionMessageToChatMessage(message));
}

function messagePartToSessionPart(part: MessagePart): SessionMessagePart {
	switch (part.type) {
		case 'text': {
			return { type: part.type, text: part.content };
		}
		case 'preview-element': {
			return { type: 'text', text: previewElementToPromptText(part) };
		}
		case 'reasoning': {
			return { type: part.type, text: part.content };
		}
		case 'tool-call': {
			return {
				type: part.type,
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: part.arguments,
			};
		}
		case 'tool-result': {
			return {
				type: part.type,
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				result: part.result,
				state: part.isError ? 'error' : 'output-available',
				output: part.result,
			};
		}
	}
}

function sessionPartToMessagePart(part: SessionMessagePart): MessagePart {
	switch (part.type) {
		case 'tool-call': {
			return {
				type: 'tool-call',
				toolCallId: part.toolCallId ?? crypto.randomUUID(),
				toolName: part.toolName ?? 'unknown_tool',
				arguments: sessionInputToRecord(part.input),
			};
		}
		case 'tool-result': {
			return {
				type: 'tool-result',
				toolCallId: part.toolCallId ?? crypto.randomUUID(),
				toolName: part.toolName ?? 'unknown_tool',
				result: sessionOutputToString(part.result ?? part.output),
				isError: part.state === 'error',
			};
		}
		case 'reasoning': {
			return { type: 'reasoning', content: part.text ?? '' };
		}
		default: {
			return { type: 'text', content: part.text ?? sessionOutputToString(part.result ?? part.output) };
		}
	}
}

function sessionInputToRecord(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return {};
	}
	return Object.fromEntries(Object.entries(input));
}

function sessionOutputToString(output: unknown): string {
	if (typeof output === 'string') {
		return output;
	}
	if (output === undefined) {
		return '';
	}
	try {
		return JSON.stringify(output);
	} catch {
		return String(output);
	}
}
