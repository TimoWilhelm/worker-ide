import { createApiClient } from './api-client';

import type { ServerLintDiagnostic } from '@shared/biome-types';

export type LintDiagnostic = ServerLintDiagnostic;

export interface LintFixResult {
	content: string;
	fixCount: number;
	remainingDiagnostics: LintDiagnostic[];
}

const LINTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.json']);

export function isLintableFile(filePath: string): boolean {
	const extension = filePath.slice(filePath.lastIndexOf('.'));
	return LINTABLE_EXTENSIONS.has(extension);
}

export async function lintFile(projectId: string, filePath: string, content: string): Promise<LintDiagnostic[]> {
	if (!isLintableFile(filePath)) {
		return [];
	}

	try {
		const api = createApiClient(projectId);
		const response = await api.lint.check.$post({ json: { path: filePath, content } });
		if (!response.ok) {
			throw new Error('Failed to lint file');
		}
		const result = await response.json();
		return result.diagnostics;
	} catch (error) {
		console.warn('[biome-linter] lintFile failed:', error);
		return [];
	}
}

export async function fixFile(projectId: string, filePath: string, content: string): Promise<LintFixResult | undefined> {
	if (!isLintableFile(filePath)) {
		return undefined;
	}

	try {
		const api = createApiClient(projectId);
		const response = await api.lint.fix.$post({ json: { path: filePath, content } });
		if (!response.ok) {
			throw new Error('Failed to fix file');
		}
		const result = await response.json();
		return {
			content: result.fixedContent,
			fixCount: result.fixCount,
			remainingDiagnostics: result.remainingDiagnostics,
		};
	} catch (error) {
		console.warn('[biome-linter] fixFile failed:', error);
		return undefined;
	}
}

export async function applySingleFix(
	projectId: string,
	filePath: string,
	content: string,
	from: number,
	to: number,
): Promise<string | undefined> {
	if (!isLintableFile(filePath)) return undefined;

	try {
		const api = createApiClient(projectId);
		const response = await api.lint['apply-fix'].$post({ json: { path: filePath, content, from, to } });
		if (!response.ok) {
			throw new Error('Failed to apply lint fix');
		}
		const result = await response.json();
		return result.fixedContent;
	} catch (error) {
		console.warn('[biome-linter] applySingleFix failed:', error);
		return undefined;
	}
}
