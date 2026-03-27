export function getConfig(environment: GitWorkerEnvironment) {
	// Parse configuration from env vars with sensible defaults.
	// All values are validated and clamped to safe ranges.
	const idleMins = Number(environment.REPO_DO_IDLE_MINUTES ?? 30);
	const maintMins = Number(environment.REPO_DO_MAINT_MINUTES ?? 60 * 24);
	const keepPacks = Number(environment.REPO_KEEP_PACKS ?? 10);
	const packListMaxRaw = Number(environment.REPO_PACKLIST_MAX ?? 50);
	const unpackChunkSize = Number(environment.REPO_UNPACK_CHUNK_SIZE ?? 100);
	const unpackMaxMs = Number(environment.REPO_UNPACK_MAX_MS ?? 2000);
	const unpackDelayMs = Number(environment.REPO_UNPACK_DELAY_MS ?? 500);
	const unpackBackoffMs = Number(environment.REPO_UNPACK_BACKOFF_MS ?? 1000);
	const clamp = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : min);
	const packListMax = clamp(packListMaxRaw, 1, 100);
	return {
		idleMs: clamp(idleMins, 1, 60 * 24 * 7) * 60 * 1000,
		maintMs: clamp(maintMins, 5, 60 * 24 * 30) * 60 * 1000,
		// keepPacks cannot exceed the recent-list window (packListMax)
		keepPacks: clamp(keepPacks, 1, packListMax),
		packListMax,
		unpackChunkSize: clamp(unpackChunkSize, 1, 1000),
		unpackMaxMs: clamp(unpackMaxMs, 50, 30_000),
		unpackDelayMs: clamp(unpackDelayMs, 10, 10_000),
		unpackBackoffMs: clamp(unpackBackoffMs, 100, 60_000),
	};
}
