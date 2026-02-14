/**
 * Tool: user_question
 * Ask the user clarifying questions.
 */

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Ask the user a clarifying question. The question will be displayed to the user and they will answer in their next message. Use this when you need user input to proceed.

Usage:
- Use this when the user's intent is ambiguous or you need a decision.
- Provide suggested options as a comma-separated string to help guide the user.
- The user can pick from the options or provide a custom answer.
- The answer will arrive in the user's next message, so plan accordingly.`;

export const definition: ToolDefinition = {
	name: 'user_question',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			question: { type: 'string', description: 'The question to ask the user' },
			options: { type: 'string', description: 'Comma-separated list of suggested options for the user' },
		},
		required: ['question'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	_context: ToolExecutorContext,
): Promise<string | object> {
	const questionText = input.question;
	const questionOptions = input.options;

	await sendEvent('status', { message: 'Asking user...' });

	let resultText = `Question for the user: ${questionText}`;
	if (questionOptions) {
		resultText += `\nSuggested options: ${questionOptions}`;
	}
	resultText += '\n\nThe user will respond in their next message.';

	return { question: questionText, options: questionOptions, message: resultText };
}
