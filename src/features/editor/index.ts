/**
 * Editor Feature Barrel Export
 *
 * Re-exports all editor-related components, hooks, and utilities.
 */

// Components
export { CodeEditor } from './components/code-editor';
export { DiffToolbar } from './components/diff-toolbar';
export { FileTabs } from './components/file-tabs';
export { GitDiffToolbar } from './components/git-diff-toolbar';

// Hooks
export { useFileContent } from './hooks/use-file-content';

// Diff utilities
export { computeDiffData, groupHunksIntoChanges } from './lib/diff-decorations';
