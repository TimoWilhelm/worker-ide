import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { disconnectCloudflare, getCloudflareConnection, listCloudflareAccounts } from '@/lib/api-client';

const CONNECTION_QUERY_KEY = ['cloudflare-connection'];
const ACCOUNTS_QUERY_KEY = ['cloudflare-accounts'];

/**
 * Manages the user's Cloudflare OAuth connection used for deployment:
 * connection status, account list, and connect/disconnect actions.
 *
 * The connect flow opens Cloudflare's consent page in a popup; the callback
 * page posts a `cloudflare-oauth` message back to this window when done.
 */
export function useCloudflareConnection(enabled: boolean) {
	const queryClient = useQueryClient();
	const [isConnecting, setIsConnecting] = useState(false);
	const popupPollReference = useRef<ReturnType<typeof setInterval>>(undefined);

	const stopConnecting = useCallback(() => {
		setIsConnecting(false);
		if (popupPollReference.current) {
			clearInterval(popupPollReference.current);
			popupPollReference.current = undefined;
		}
	}, []);

	const connectionQuery = useQuery({
		queryKey: CONNECTION_QUERY_KEY,
		queryFn: getCloudflareConnection,
		enabled,
		staleTime: 1000 * 60,
	});

	const connected = connectionQuery.data?.connected ?? false;

	const accountsQuery = useQuery({
		queryKey: ACCOUNTS_QUERY_KEY,
		queryFn: listCloudflareAccounts,
		enabled: enabled && connected,
		staleTime: 1000 * 60,
	});

	const refreshConnection = useCallback(async () => {
		await queryClient.invalidateQueries({ queryKey: CONNECTION_QUERY_KEY });
		await queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
	}, [queryClient]);

	const disconnectMutation = useMutation({
		mutationFn: disconnectCloudflare,
		onSuccess: async () => {
			await refreshConnection();
		},
	});

	// Listen for the popup callback signalling that authorization finished.
	useEffect(() => {
		if (!enabled) return;

		function handleMessage(event: MessageEvent) {
			if (event.origin !== globalThis.location.origin) return;
			const data: unknown = event.data;
			if (typeof data !== 'object' || data === null) return;
			if (!('type' in data) || data.type !== 'cloudflare-oauth') return;
			void refreshConnection().finally(stopConnecting);
		}

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, [enabled, refreshConnection, stopConnecting]);

	// Clean up the popup poll on unmount.
	useEffect(() => stopConnecting, [stopConnecting]);

	const connect = useCallback(() => {
		const width = 600;
		const height = 720;
		const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
		const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
		const popup = window.open(
			'/api/cloudflare/oauth/connect',
			'cloudflare-oauth',
			`width=${width},height=${height},left=${left},top=${top}`,
		);
		if (!popup) return;

		setIsConnecting(true);
		// Reset the connecting state if the user closes the popup without finishing.
		popupPollReference.current = setInterval(() => {
			if (popup.closed) stopConnecting();
		}, 500);
	}, [stopConnecting]);

	return {
		isLoadingConnection: connectionQuery.isLoading,
		connected,
		email: connectionQuery.data?.email,
		accounts: accountsQuery.data ?? [],
		isLoadingAccounts: accountsQuery.isLoading,
		accountsError: accountsQuery.isError,
		connect,
		isConnecting,
		disconnect: disconnectMutation.mutate,
		isDisconnecting: disconnectMutation.isPending,
		refreshConnection,
	};
}
