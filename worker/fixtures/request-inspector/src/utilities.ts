export function formatBytes(bytes: number, decimals = 2): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const index = Math.floor(Math.log(bytes) / Math.log(k));
	const value = bytes / Math.pow(k, index);
	return `${Number.parseFloat(value.toFixed(decimals))} ${sizes[index]}`;
}
export function parseHeaderList(header: string): string[] {
	if (!header.trim()) return [];
	return header
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}
export function maskSensitiveValue(value: string, visibleChars = 4): string {
	if (value.length <= visibleChars) return '****';
	return value.slice(0, visibleChars) + '****';
}
