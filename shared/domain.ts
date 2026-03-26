/**
 * Domain parsing and preview URL utilities.
 *
 * Subdomain layout:
 * - App:     <baseDomain>                                  (localhost:3000, example.com)
 * - Preview: <projectId>-<token>.preview.<baseDomain>      (x7f3k2-a1b2c3d4e5f6.preview.localhost:3000)
 *
 * The preview subdomain encodes both the project ID and an HMAC-signed
 * time-bucket token separated by a single hyphen. Since project IDs are
 * strictly `[a-z0-9]` (no hyphens), the last `-` in the first subdomain
 * label unambiguously separates the project ID from the token.
 *
 * Supports single-segment (localhost) and two-segment (example.com) base domains.
 *
 * LIMITATION: Multi-segment TLDs (e.g., .co.uk, .com.au) are NOT supported.
 * The parser assumes all non-localhost domains have exactly 2 segments.
 * If deploying to a ccTLD, add the TLD to SINGLE_SEGMENT_HOSTS or extend
 * getBaseDomainSegmentCount() with a public suffix list.
 */

import { PREVIEW_TOKEN_PATTERN } from './preview-token';
import { isValidProjectId } from './project-id';

const SINGLE_SEGMENT_HOSTS = new Set(['localhost']);

// -- Types --------------------------------------------------------------------

export type ParsedHost =
	| { type: 'preview'; projectId: string; token: string; baseDomain: string }
	| { type: 'app'; baseDomain: string }
	| { type: 'unknown'; baseDomain: string };

// -- Host parsing -------------------------------------------------------------

function getBaseDomainSegmentCount(parts: string[]): number {
	const lastSegment = parts.at(-1)?.split(':')[0] ?? '';
	return SINGLE_SEGMENT_HOSTS.has(lastSegment) ? 1 : 2;
}

/**
 * Parse the preview subdomain label into projectId and token.
 *
 * The label format is `<projectId>-<token>` where projectId is `[a-z0-9]+`
 * (no hyphens) and token is exactly 12 lowercase hex characters. We split
 * on the last hyphen to separate them.
 */
function parsePreviewLabel(label: string): { projectId: string; token: string } | undefined {
	const dashIndex = label.lastIndexOf('-');
	if (dashIndex <= 0) return undefined;

	const projectId = label.slice(0, dashIndex);
	const token = label.slice(dashIndex + 1);

	if (!isValidProjectId(projectId)) return undefined;
	if (!PREVIEW_TOKEN_PATTERN.test(token)) return undefined;

	return { projectId, token };
}

/**
 * Parse a hostname to determine its routing role.
 *
 * Detection logic after extracting the base domain:
 * - No subdomain                              → app (dashboard + IDE)
 * - "<projectId>-<token>.preview"             → preview
 * - Anything else                             → unknown
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

	if (subdomainParts.length === 2 && subdomainParts[1] === 'preview') {
		const parsed = parsePreviewLabel(subdomainParts[0]);
		if (parsed) {
			return { type: 'preview', projectId: parsed.projectId, token: parsed.token, baseDomain };
		}
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

export function buildPreviewOrigin(projectId: string, token: string, baseDomain: string, protocol = 'https:'): string {
	return `${protocol}//${projectId}-${token}.preview.${baseDomain}`;
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
