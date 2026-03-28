export const WebPushResult = {
	SUCCESS: 'SUCCESS',
	ERROR: 'ERROR',
	NOT_SUBSCRIBED: 'NOT_SUBSCRIBED',
} as const;

export type WebPushResultType = keyof typeof WebPushResult;
