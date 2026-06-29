/**
 * Wire protocol between the stateless preview router and the runtime build-host
 * Durable Object (`VinextPreviewHost`).
 *
 * Kept in its own light module (no DO/ViteHost imports) so the stateless side
 * can reference it without pulling the heavy build host into its module graph.
 */

/** Request headers carrying preview context to the build-host Durable Object. */
export const VINEXT_PREVIEW_HEADERS = {
	projectId: 'x-vinext-project-id',
	projectRoot: 'x-vinext-project-root',
	ideOrigin: 'x-vinext-ide-origin',
	/** The framework runtime id (from the registry) that claimed this project. */
	runtimeId: 'x-vinext-runtime-id',
} as const;
