/**
 * Domain parsing and preview URL utilities.
 *
 * Subdomain layout:
 * - App:     <baseDomain>                        (localhost:3000, example.com)
 * - Preview: <encoded-id>.preview.<baseDomain>   (x7f3k2.preview.localhost:3000)
 *
 * Project IDs are 64-char hex strings (Durable Object IDs). For DNS-safe
 * subdomains, they are base36-encoded to fit within the 63-char label limit.
 *
 * Supports single-segment (localhost) and two-segment (example.com) base domains.
 *
 * LIMITATION: Multi-segment TLDs (e.g., .co.uk, .com.au) are NOT supported.
 * The parser assumes all non-localhost domains have exactly 2 segments.
 * If deploying to a ccTLD, add the TLD to SINGLE_SEGMENT_HOSTS or extend
 * getBaseDomainSegmentCount() with a public suffix list.
 */

const PROJECT_ID_PATTERN = /^[a-f\d]{64}$/i;
const BASE36_PATTERN = /^[a-z\d]+$/;
const SINGLE_SEGMENT_HOSTS = new Set(['localhost']);

// -- Types --------------------------------------------------------------------

type ParsedHost =
	| { type: 'preview'; projectId: string; baseDomain: string }
	| { type: 'app'; baseDomain: string }
	| { type: 'unknown'; baseDomain: string };

// -- Base36 encoding ----------------------------------------------------------

/** Encode a 64-char hex project ID to a shorter base36 string (≤50 chars). */
export function encodeProjectId(hex: string): string {
	return BigInt(`0x${hex}`).toString(36);
}

/** Decode a base36-encoded project ID back to a 64-char hex string. */
export function decodeProjectId(encoded: string): string {
	let value = 0n;
	for (const char of encoded) {
		const digit = Number.parseInt(char, 36);
		value = value * 36n + BigInt(digit);
	}
	return value.toString(16).padStart(64, '0');
}

/** Check if a string is a valid base36-encoded project ID. */
function isValidEncodedId(value: string): boolean {
	if (!BASE36_PATTERN.test(value) || value.length === 0 || value.length > 50) {
		return false;
	}
	try {
		const hex = decodeProjectId(value);
		return PROJECT_ID_PATTERN.test(hex);
	} catch {
		return false;
	}
}

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
 * - "<encoded>.preview"        → preview (decoded to 64-char hex)
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

	if (subdomainParts.length === 2 && subdomainParts[1] === 'preview' && isValidEncodedId(subdomainParts[0])) {
		return { type: 'preview', projectId: decodeProjectId(subdomainParts[0]), baseDomain };
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
	return `${protocol}//${encodeProjectId(projectId)}.preview.${baseDomain}`;
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
