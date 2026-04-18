import type { PreviewElementAttributes, PreviewElementReference } from './types';

const MAX_SELECTOR_LENGTH = 400;
const MAX_TEXT_LENGTH = 160;
const MAX_CLASS_NAME_LENGTH = 120;
const MAX_LOCATOR_CANDIDATES = 6;
const SAFE_ATTRIBUTE_KEYS = ['id', 'name', 'alt', 'title', 'placeholder', 'type', 'href', 'src'] as const;

type SafePreviewElementAttributeKey = (typeof SAFE_ATTRIBUTE_KEYS)[number];

function collapseWhitespace(value: string): string {
	return value.replaceAll(/\s+/g, ' ').trim();
}

function sanitizeBoundedText(value: string | undefined, maxLength = MAX_TEXT_LENGTH): string | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = collapseWhitespace(value);
	if (!normalized) {
		return undefined;
	}

	return normalized.length > maxLength ? normalized.slice(0, maxLength).trimEnd() : normalized;
}

function sanitizeSelector(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = collapseWhitespace(value);
	if (!normalized) {
		return undefined;
	}

	return normalized.length > MAX_SELECTOR_LENGTH ? normalized.slice(0, MAX_SELECTOR_LENGTH).trimEnd() : normalized;
}

function sanitizeUrlHint(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	try {
		const url = new URL(value, 'http://placeholder.local');
		const pathname = sanitizeBoundedText(url.pathname, MAX_TEXT_LENGTH);
		if (!pathname) {
			return undefined;
		}

		return url.origin === 'http://placeholder.local' ? pathname : `${url.origin}${pathname}`;
	} catch {
		const normalized = value.split(/[?#]/u, 1)[0];
		return sanitizeBoundedText(normalized, MAX_TEXT_LENGTH);
	}
}

function sanitizeAttributeValue(key: SafePreviewElementAttributeKey, value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	if (key === 'href' || key === 'src') {
		return sanitizeUrlHint(value);
	}

	return sanitizeBoundedText(value, MAX_TEXT_LENGTH);
}

function sanitizeAttributes(attributes: unknown): PreviewElementAttributes | undefined {
	if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
		return undefined;
	}

	const nextAttributes: PreviewElementAttributes = {};
	for (const key of SAFE_ATTRIBUTE_KEYS) {
		const rawValue = Reflect.get(attributes, key);
		if (typeof rawValue !== 'string') {
			continue;
		}

		const sanitizedValue = sanitizeAttributeValue(key, rawValue);
		if (sanitizedValue) {
			nextAttributes[key] = sanitizedValue;
		}
	}

	return Object.keys(nextAttributes).length > 0 ? nextAttributes : undefined;
}

function sanitizeLocatorCandidates(candidates: unknown, primarySelector: string): string[] {
	if (!Array.isArray(candidates)) {
		return [];
	}

	const uniqueCandidates = new Set<string>();
	for (const candidate of candidates) {
		if (typeof candidate !== 'string') {
			continue;
		}

		const sanitizedCandidate = sanitizeSelector(candidate);
		if (!sanitizedCandidate || sanitizedCandidate === primarySelector) {
			continue;
		}

		uniqueCandidates.add(sanitizedCandidate);
		if (uniqueCandidates.size >= MAX_LOCATOR_CANDIDATES) {
			break;
		}
	}

	return [...uniqueCandidates];
}

export function normalizePreviewElementTagName(tagName: string): string {
	const normalizedTagName = tagName.trim().replaceAll(/[<>]/g, '').toLowerCase();
	return normalizedTagName || 'element';
}

export function getPreviewElementLabel(tagName: string): string {
	return `<${normalizePreviewElementTagName(tagName)}>`;
}

export function getPreviewElementSummary(reference: PreviewElementReference): string | undefined {
	return (
		reference.accessibleName ??
		reference.textPreview ??
		reference.attributes?.alt ??
		reference.attributes?.title ??
		reference.attributes?.placeholder ??
		reference.attributes?.name
	);
}

export function getPreviewElementDisplayText(reference: PreviewElementReference): string {
	const label = getPreviewElementLabel(reference.tagName);
	const summary = getPreviewElementSummary(reference);
	return summary ? `${label} ${summary}` : label;
}

export function previewElementToPromptText(reference: PreviewElementReference): string {
	const details = [
		reference.role ? `role=${reference.role}` : undefined,
		reference.className ? `class=${reference.className}` : undefined,
		reference.attributes?.name ? `name=${reference.attributes.name}` : undefined,
		reference.attributes?.type ? `type=${reference.attributes.type}` : undefined,
	]
		.filter(Boolean)
		.join(', ');

	const summary = getPreviewElementSummary(reference);
	const base = summary
		? `selected ${getPreviewElementLabel(reference.tagName)} "${summary}"`
		: `selected ${getPreviewElementLabel(reference.tagName)}`;
	return details ? `${base} (${details})` : base;
}

export function getPreviewElementReferenceKey(reference: PreviewElementReference): string {
	return `${normalizePreviewElementTagName(reference.tagName)}|${reference.primarySelector}`;
}

export function sanitizePreviewElementReference(reference: unknown): PreviewElementReference | undefined {
	if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
		return undefined;
	}

	const rawTagName = Reflect.get(reference, 'tagName');
	const rawPrimarySelector = Reflect.get(reference, 'primarySelector');
	if (typeof rawTagName !== 'string' || typeof rawPrimarySelector !== 'string') {
		return undefined;
	}

	const primarySelector = sanitizeSelector(rawPrimarySelector);
	if (!primarySelector) {
		return undefined;
	}

	const sanitizedReference: PreviewElementReference = {
		tagName: normalizePreviewElementTagName(rawTagName),
		primarySelector,
		locatorCandidates: sanitizeLocatorCandidates(Reflect.get(reference, 'locatorCandidates'), primarySelector),
	};

	const containerSelector = sanitizeSelector(
		typeof Reflect.get(reference, 'containerSelector') === 'string' ? Reflect.get(reference, 'containerSelector') : undefined,
	);
	if (containerSelector) {
		sanitizedReference.containerSelector = containerSelector;
	}

	const textPreview = sanitizeBoundedText(
		typeof Reflect.get(reference, 'textPreview') === 'string' ? Reflect.get(reference, 'textPreview') : undefined,
	);
	if (textPreview) {
		sanitizedReference.textPreview = textPreview;
	}

	const accessibleName = sanitizeBoundedText(
		typeof Reflect.get(reference, 'accessibleName') === 'string' ? Reflect.get(reference, 'accessibleName') : undefined,
	);
	if (accessibleName) {
		sanitizedReference.accessibleName = accessibleName;
	}

	const role = sanitizeBoundedText(typeof Reflect.get(reference, 'role') === 'string' ? Reflect.get(reference, 'role') : undefined, 40);
	if (role) {
		sanitizedReference.role = role;
	}

	const className = sanitizeBoundedText(
		typeof Reflect.get(reference, 'className') === 'string' ? Reflect.get(reference, 'className') : undefined,
		MAX_CLASS_NAME_LENGTH,
	);
	if (className) {
		sanitizedReference.className = className;
	}

	const attributes = sanitizeAttributes(Reflect.get(reference, 'attributes'));
	if (attributes) {
		sanitizedReference.attributes = attributes;
	}

	return sanitizedReference;
}
