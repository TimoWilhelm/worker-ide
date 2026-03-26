export { getDatabase } from './client';
export type { AgentDatabase } from './client';

export {
	clearSessionRevertedAt,
	deleteSession,
	deletePendingChanges,
	getAllRunningSessions,
	getRunningSessionIds,
	insertSession,
	isSessionRunning,
	listSessionIdsForPruning,
	listSessionSummaries,
	markSessionRunning,
	readPendingChangesData,
	readSession,
	removeAllRunningSessions,
	removeRunningSession,
	updateSessionForRevert,
	updateSessionHistory,
	updateSessionStatus,
	updateSessionTitle,
	upsertSessionFromService,
	writePendingChangesData,
} from './dal';

export type { PendingChangesRow, RunningSessionRow, SessionInsert, SessionRow } from './schema';
