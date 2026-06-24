// Per-file write locks for serializing concurrent writes.
const locks = new Map<string, Promise<void>>();

function normalizePath(filepath: string): string {
	return filepath.startsWith('/') ? filepath : `/${filepath}`;
}

/**
 * Serialize concurrent writes to the same file. Tools that read-modify-write an
 * existing file should run that sequence inside `withLock` so concurrent calls
 * (e.g. parallel tool calls in a single Code Mode run) cannot clobber each other.
 */
export async function withLock<T>(filepath: string, function_: () => Promise<T>): Promise<T> {
	const normalized = normalizePath(filepath);
	const currentLock = locks.get(normalized) ?? Promise.resolve();

	// Create a deferred promise whose resolve function acts as the lock release.
	let resolve!: () => void;
	const nextLock = new Promise<void>((r) => {
		resolve = r;
	});
	const chained = currentLock.then(() => nextLock);
	locks.set(normalized, chained);

	await currentLock;
	try {
		return await function_();
	} finally {
		resolve();
		if (locks.get(normalized) === chained) {
			locks.delete(normalized);
		}
	}
}
