/**
 * Domain parsing and preview URL utilities.
 *
 * Subdomain layout:
 * - App:     <baseDomain>                       (localhost:3000, example.com)
 * - Preview: <projectId>.preview.<baseDomain>   (x7f3k2.preview.localhost:3000)
 *
 * Supports single-segment (localhost) and two-segment (example.com) base domains.
 *
 * LIMITATION: Multi-segment TLDs (e.g., .co.uk, .com.au) are NOT supported.
 * The parser assumes all non-localhost domains have exactly 2 segments.
 * If deploying to a ccTLD, add the TLD to SINGLE_SEGMENT_HOSTS or extend
 * getBaseDomainSegmentCount() with a public suffix list.
 */

import { isValidProjectId } from './project-id';

const SINGLE_SEGMENT_HOSTS = new Set(['localhost']);

// -- Types --------------------------------------------------------------------

type ParsedHost =
	| { type: 'preview'; projectId: string; baseDomain: string }
	| { type: 'app'; baseDomain: string }
	| { type: 'unknown'; baseDomain: string };

// -- Host parsing -------------------------------------------------------------

function getBaseDomainSegmentCount(parts: string[]): number {
	const lastSegment = parts.at(-1)?.split(':')[0] ?? '';
	return SINGLE_SEGMENT_HOSTS.has(lastSegment) ? 1 : 2;
}

/**
 * Parse a hostname to determine its routing role.
 *
 * Detection logic after extracting the base domain:
 * - No subdomain               → app (dashboard + IDE)
 * - "<projectId>.preview"      → preview
 * - Anything else              → unknown
 */
export function parseHost(host: string): ParsedHost {
	const parts = host.split('.');
	const baseSegments = getBaseDomainSegmentCount(parts);

	if (parts.length < baseSegments) {
		return { type: 'app', baseDomain: host };
	}

	const baseDomain = parts.slice(-baseSegments).join('.');
	const subdomainParts = parts.slice(0, -baseSegments);

	if (subdomainParts.length === 0) {
		return { type: 'app', baseDomain };
	}

	if (subdomainParts.length === 2 && subdomainParts[1] === 'preview' && isValidProjectId(subdomainParts[0])) {
		return { type: 'preview', projectId: subdomainParts[0], baseDomain };
	}

	return { type: 'unknown', baseDomain };
}

// -- URL builders -------------------------------------------------------------

export function getBaseDomain(host: string): string {
	return parseHost(host).baseDomain;
}

export function buildAppOrigin(baseDomain: string, protocol = 'https:'): string {
	return `${protocol}//${baseDomain}`;
}

export function buildPreviewOrigin(projectId: string, baseDomain: string, protocol = 'https:'): string {
	return `${protocol}//${projectId}.preview.${baseDomain}`;
}

export function isPreviewOrigin(origin: string, baseDomain: string): boolean {
	try {
		const url = new URL(origin);
		const parsed = parseHost(url.host);
		return parsed.type === 'preview' && parsed.baseDomain === baseDomain;
	} catch {
		return false;
	}
}
