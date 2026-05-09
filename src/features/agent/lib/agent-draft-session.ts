import { clearAgentDraft, loadAgentDraft, saveAgentDraft } from '@/lib/project-storage';

import type { InputSegment } from './input-segments';
import type { PreviewElementAttributes } from '@shared/types';

export interface AgentDraftSession {
	segments: InputSegment[];
	cursorPosition: number;
}

function isPreviewElementAttributes(value: unknown): value is PreviewElementAttributes {
	if (value === undefined) {
		return true;
	}

	if (!value || typeof value !== 'object') {
		return false;
	}

	return (
		(!('id' in value) || value.id === undefined || typeof value.id === 'string') &&
		(!('name' in value) || value.name === undefined || typeof value.name === 'string') &&
		(!('alt' in value) || value.alt === undefined || typeof value.alt === 'string') &&
		(!('title' in value) || value.title === undefined || typeof value.title === 'string') &&
		(!('placeholder' in value) || value.placeholder === undefined || typeof value.placeholder === 'string') &&
		(!('type' in value) || value.type === undefined || typeof value.type === 'string') &&
		(!('href' in value) || value.href === undefined || typeof value.href === 'string') &&
		(!('src' in value) || value.src === undefined || typeof value.src === 'string')
	);
}

function isInputSegment(value: unknown): value is InputSegment {
	if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') {
		return false;
	}

	if (value.type === 'text') {
		return 'value' in value && typeof value.value === 'string';
	}

	if (value.type === 'mention') {
		return 'path' in value && typeof value.path === 'string';
	}

	if (value.type !== 'preview-element') {
		return false;
	}

	return (
		'tagName' in value &&
		typeof value.tagName === 'string' &&
		'primarySelector' in value &&
		typeof value.primarySelector === 'string' &&
		'locatorCandidates' in value &&
		Array.isArray(value.locatorCandidates) &&
		value.locatorCandidates.every((candidate) => typeof candidate === 'string') &&
		(!('containerSelector' in value) || value.containerSelector === undefined || typeof value.containerSelector === 'string') &&
		(!('textPreview' in value) || value.textPreview === undefined || typeof value.textPreview === 'string') &&
		(!('accessibleName' in value) || value.accessibleName === undefined || typeof value.accessibleName === 'string') &&
		(!('role' in value) || value.role === undefined || typeof value.role === 'string') &&
		(!('className' in value) || value.className === undefined || typeof value.className === 'string') &&
		(!('attributes' in value) || isPreviewElementAttributes(value.attributes))
	);
}

function normalizeAgentDraftSession(value: unknown): AgentDraftSession | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	if (!('segments' in value) || !Array.isArray(value.segments) || !value.segments.every((segment) => isInputSegment(segment))) {
		return undefined;
	}

	if (!('cursorPosition' in value) || typeof value.cursorPosition !== 'number' || Number.isNaN(value.cursorPosition)) {
		return undefined;
	}

	return {
		segments: value.segments,
		cursorPosition: Math.max(0, Math.trunc(value.cursorPosition)),
	};
}

export function loadAgentDraftSession(projectId: string): AgentDraftSession | undefined {
	const raw = loadAgentDraft(projectId);
	if (!raw) return undefined;
	return normalizeAgentDraftSession(raw);
}

export function saveAgentDraftSession(projectId: string, session: AgentDraftSession): void {
	saveAgentDraft(projectId, session);
}

export function clearAgentDraftSession(projectId: string): void {
	clearAgentDraft(projectId);
}
