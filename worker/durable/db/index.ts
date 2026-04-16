export { getDatabase } from './client';
export type { AgentDatabase } from './client';

export {
	deletePendingChanges,
	deleteSessionMetadata,
	readPendingChangesData,
	readSessionMetadata,
	updateSessionMetadataStatus,
	updateSessionMetadataTitleGenerated,
	upsertSessionMetadata,
	writePendingChangesData,
} from './dal';

export type { PendingChangesRow, SessionMetadataInsert, SessionMetadataRow } from './schema';
