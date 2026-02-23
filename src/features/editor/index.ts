/**
 * Editor Feature Barrel Export
 *
 * Re-exports all editor-related components, hooks, and utilities.
 */

// Components
export { CodeEditor, type CodeEditorProperties, useEditorReference } from './components/code-editor';
export { DiffToolbar, type DiffToolbarProperties } from './components/diff-toolbar';
export { FileTabs, type FileTab, type FileTabsProperties } from './components/file-tabs';
export { GitDiffToolbar, type GitDiffToolbarProperties } from './components/git-diff-toolbar';

// Hooks
export { useFileContent, useFileList } from './hooks/use-file-content';

// Diff utilities
export {
	computeDiffData,
	groupHunksIntoChanges,
	reconstructContent,
	type ChangeGroup,
	type DiffData,
	type DiffHunk,
} from './lib/diff-decorations';
export { createAiActionBarExtension, createDiffDecorations } from './lib/diff-extension';

// Extensions (for advanced usage)
export {
	darkTheme,
	darkHighlightStyle,
	lightTheme,
	lightHighlightStyle,
	getLanguageExtension,
	getBaseExtensions,
	createEditorExtensions,
	readonlyExtension,
	createTabSizeExtension,
} from './lib/extensions';
