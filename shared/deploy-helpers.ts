export function sanitizeWorkerName(name: string): string {
	return (
		name
			.toLowerCase()
			.replaceAll(/[^a-z\d-]/g, '-')
			.replaceAll(/-+/g, '-')
			.replaceAll(/^-|-$/g, '')
			.slice(0, 63) || 'my-worker'
	);
}

function hashBucketNameSeed(value: string): string {
	let hash = 2_166_136_261;
	for (const character of value) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export function sanitizeR2BucketName(workerName: string): string {
	const normalized = workerName
		.toLowerCase()
		.replaceAll(/[^a-z\d-]/g, '-')
		.replaceAll(/-+/g, '-')
		.replace(/^-/, '')
		.replace(/-$/, '');

	const base = normalized.length > 0 ? normalized : 'app';
	const suffix = `-storage-${hashBucketNameSeed(workerName)}`;
	const maxBaseLength = 63 - suffix.length;
	const trimmed = (maxBaseLength > 0 ? base.slice(0, maxBaseLength) : '').replace(/-$/, '') || 'app';
	return `${trimmed}${suffix}`;
}
