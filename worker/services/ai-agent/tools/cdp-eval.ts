/**
 * Tool: cdp_eval
 * Send Chrome DevTools Protocol (CDP) commands to the preview iframe via chobitsu.
 *
 * Supports any CDP method (Runtime.evaluate, DOM.getDocument, Network.*, CSS.*, etc.).
 * The command is relayed through the ProjectCoordinator WebSocket to a connected
 * frontend client, which forwards it to chobitsu in the preview iframe.
 */

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Execute a Chrome DevTools Protocol (CDP) command in the project's live preview iframe. Use this to run JavaScript, inspect the DOM, check network activity, read console output, and debug runtime issues.

Common CDP methods:
- Runtime.evaluate: Execute JavaScript in the preview. Params: { "expression": "document.title" }
- Runtime.getProperties: Get properties of an object by objectId.
- DOM.getDocument: Get the root DOM node.
- DOM.querySelector: Find an element. Params: { "nodeId": 1, "selector": ".my-class" }
- CSS.getComputedStyleForNode: Get computed styles. Params: { "nodeId": 123 }
- Network.enable: Start tracking network requests.

Usage:
- The \`method\` parameter is the CDP method name (e.g. "Runtime.evaluate").
- The \`params\` parameter is a JSON string of the CDP method parameters.
- For Runtime.evaluate, set "returnByValue": true to get serialized results instead of object references.
- This tool is read-only and does not modify project files.
- Results are returned as JSON strings from the CDP response.
- If the preview is not loaded or no browser is connected, a descriptive error is returned.`;

export const definition: ToolDefinition = {
	name: 'cdp_eval',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			method: {
				type: 'string',
				description: 'The CDP method to call (e.g. "Runtime.evaluate", "DOM.getDocument")',
			},
			params: {
				type: 'string',
				description: 'JSON-encoded parameters for the CDP method (e.g. \'{"expression": "document.title", "returnByValue": true}\')',
			},
		},
		required: ['method'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<string | object> {
	const method = input.method;
	const parametersRaw = input.params;

	if (!method) {
		return { error: 'The "method" parameter is required.' };
	}

	// Parse params JSON if provided
	let parameters: Record<string, unknown> | undefined;
	if (parametersRaw) {
		try {
			const parsed: unknown = JSON.parse(parametersRaw);
			if (typeof parsed !== 'object' || !parsed || Array.isArray(parsed)) {
				return { error: 'Invalid params: must be a JSON object (not array or primitive).' };
			}
			// parsed is a non-null, non-array object at this point
			parameters = Object.fromEntries(Object.entries(parsed));
		} catch {
			return { error: `Invalid params: failed to parse JSON. ${parametersRaw.slice(0, 200)}` };
		}
	}

	if (!context.sendCdpCommand) {
		return { error: 'CDP evaluation is not available in this context.' };
	}

	sendEvent('status', { message: `Running CDP: ${method}...` });

	const id = crypto.randomUUID().slice(0, 8);
	const result = await context.sendCdpCommand(id, method, parameters);

	if (result.error) {
		return { error: result.error };
	}

	return { method, result: result.result };
}
