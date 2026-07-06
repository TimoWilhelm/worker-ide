import type { ChatMessage, MessagePart } from '@shared/types';

const MAX_PERSISTED_TEXT_CHARACTERS = 8000;
const MAX_PERSISTED_REASONING_CHARACTERS = 4000;
const MAX_PERSISTED_TOOL_RESULT_CHARACTERS = 12_000;
const MAX_PERSISTED_TOOL_ARGUMENT_CHARACTERS = 12_000;

export function compactHistoryForPersistence(history: ChatMessage[]): ChatMessage[] {
	return history.map((message) => compactMessageForPersistence(message));
}

function compactMessageForPersistence(message: ChatMessage): ChatMessage {
	let changed = false;
	const compactedParts = message.parts.map((part) => {
		const compactedPart = compactPartForPersistence(part);
		if (compactedPart !== part) {
			changed = true;
		}
		return compactedPart;
	});

	return changed ? { ...message, parts: compactedParts } : message;
}

function compactPartForPersistence(part: MessagePart): MessagePart {
	switch (part.type) {
		case 'text': {
			const compactedContent = truncateText(part.content, MAX_PERSISTED_TEXT_CHARACTERS);
			return compactedContent === part.content ? part : { ...part, content: compactedContent };
		}
		case 'reasoning': {
			const compactedContent = truncateText(part.content, MAX_PERSISTED_REASONING_CHARACTERS);
			return compactedContent === part.content ? part : { ...part, content: compactedContent };
		}
		case 'tool-result': {
			if (part.result.length <= MAX_PERSISTED_TOOL_RESULT_CHARACTERS) {
				return part;
			}

			return {
				...part,
				result:
					`${part.result.slice(0, MAX_PERSISTED_TOOL_RESULT_CHARACTERS)}... ` +
					`[tool result truncated for storage; rerun ${part.toolName} if the full output is needed]`,
			};
		}
		case 'tool-call': {
			const serializedArguments = JSON.stringify(part.arguments);
			if (serializedArguments.length <= MAX_PERSISTED_TOOL_ARGUMENT_CHARACTERS) {
				return part;
			}

			const path = typeof part.arguments.path === 'string' ? part.arguments.path : undefined;
			return {
				...part,
				arguments: {
					__truncated: true,
					toolName: part.toolName,
					path,
					preview: `${serializedArguments.slice(0, MAX_PERSISTED_TOOL_ARGUMENT_CHARACTERS)}... [tool input truncated for storage]`,
				},
			};
		}
		case 'preview-element': {
			return part;
		}
		case 'image': {
			return part;
		}
	}
	/* c8 ignore next 2 */
	return part;
}

function truncateText(text: string, maxCharacters: number): string {
	if (text.length <= maxCharacters) {
		return text;
	}

	return `${text.slice(0, maxCharacters)}... [truncated ${text.length} chars]`;
}
