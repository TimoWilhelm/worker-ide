/**
 * Tool registry — barrel that collects all tool modules and builds
 * AGENT_TOOLS, PLAN_MODE_TOOLS, and the executor dispatch map.
 */

import * as dependenciesListTool from './dependencies-list';
import * as dependenciesUpdateTool from './dependencies-update';
import * as documentationSearchTool from './documentation-search';
import * as fileDeleteTool from './file-delete';
import * as fileEditTool from './file-edit';
import * as fileGlobTool from './file-glob';
import * as fileGrepTool from './file-grep';
import * as fileListTool from './file-list';
import * as fileMoveTool from './file-move';
import * as filePatchTool from './file-patch';
import * as fileReadTool from './file-read';
import * as fileWriteTool from './file-write';
import * as filesListTool from './files-list';
import * as planUpdateTool from './plan-update';
import * as todosGetTool from './todos-get';
import * as todosUpdateTool from './todos-update';
import * as userQuestionTool from './user-question';
import * as webFetchTool from './web-fetch';

import type { ToolDefinition, ToolExecuteFunction } from '../types';

// =============================================================================
// Tool executor dispatch map
// =============================================================================

export const TOOL_EXECUTORS: ReadonlyMap<string, ToolExecuteFunction> = new Map([
	['file_edit', fileEditTool.execute],
	['file_write', fileWriteTool.execute],
	['file_read', fileReadTool.execute],
	['file_grep', fileGrepTool.execute],
	['file_glob', fileGlobTool.execute],
	['file_list', fileListTool.execute],
	['files_list', filesListTool.execute],
	['file_patch', filePatchTool.execute],
	['file_delete', fileDeleteTool.execute],
	['file_move', fileMoveTool.execute],
	['user_question', userQuestionTool.execute],
	['web_fetch', webFetchTool.execute],
	['docs_search', documentationSearchTool.execute],
	['plan_update', planUpdateTool.execute],
	['todos_get', todosGetTool.execute],
	['todos_update', todosUpdateTool.execute],
	['dependencies_list', dependenciesListTool.execute],
	['dependencies_update', dependenciesUpdateTool.execute],
]);

// =============================================================================
// Tool definitions (sent to the AI model)
// =============================================================================

export const AGENT_TOOLS: readonly ToolDefinition[] = [
	fileEditTool.definition,
	fileWriteTool.definition,
	fileReadTool.definition,
	fileGrepTool.definition,
	fileGlobTool.definition,
	fileListTool.definition,
	filesListTool.definition,
	filePatchTool.definition,
	fileDeleteTool.definition,
	fileMoveTool.definition,
	userQuestionTool.definition,
	webFetchTool.definition,
	documentationSearchTool.definition,
	planUpdateTool.definition,
	todosGetTool.definition,
	todosUpdateTool.definition,
	dependenciesListTool.definition,
	dependenciesUpdateTool.definition,
];

// =============================================================================
// Plan mode tools (read-only subset)
// =============================================================================

const PLAN_MODE_TOOL_NAMES = new Set([
	'file_read',
	'file_grep',
	'file_glob',
	'file_list',
	'files_list',
	'user_question',
	'web_fetch',
	'docs_search',
	'plan_update',
	'todos_get',
	'todos_update',
	'dependencies_list',
]);

export const PLAN_MODE_TOOLS: readonly ToolDefinition[] = AGENT_TOOLS.filter((tool) => PLAN_MODE_TOOL_NAMES.has(tool.name));

// =============================================================================
// Ask mode tools (no tools — conversational only)
// =============================================================================

export const ASK_MODE_TOOLS: readonly ToolDefinition[] = [];
