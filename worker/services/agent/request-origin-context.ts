export interface RequestOriginContext {
	baseDomain: string;
	protocol: string;
}

export function isRequestOriginContext(value: unknown): value is RequestOriginContext {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}

	const record = Object.fromEntries(Object.entries(value));
	return typeof record.baseDomain === 'string' && typeof record.protocol === 'string';
}
