/**
 * Utility functions for the Request Inspector.
 */

/**
 * Format a byte count into a human-readable string.
 */
export function formatBytes(bytes: number, decimals = 2): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const index = Math.floor(Math.log(bytes) / Math.log(k));
	const value = bytes / Math.pow(k, index);
	return `${Number.parseFloat(value.toFixed(decimals))} ${sizes[index]}`;
}

/**
 * Parse a comma-separated header value into an array of trimmed strings.
 */
export function parseHeaderList(header: string): string[] {
	if (!header.trim()) return [];
	return header
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * Mask sensitive header values (e.g., Authorization) for safe display.
 */
export function maskSensitiveValue(value: string, visibleChars = 4): string {
	if (value.length <= visibleChars) return '****';
	return value.slice(0, visibleChars) + '****';
}

/**
 * Calculate relative time string from a timestamp.
 */
export function relativeTime(timestamp: string | number): string {
	const now = Date.now();
	const then = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
	const diffMs = now - then;

	if (diffMs < 1000) return 'just now';
	if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`;
	if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
	if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
	return `${Math.floor(diffMs / 86_400_000)}d ago`;
}
