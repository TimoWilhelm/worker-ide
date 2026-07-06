import { useEffect, useState } from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import { isMessageFromPreview } from '@/lib/preview-origin';
import { cn } from '@/lib/utils';

/**
 * Live Hot Module Replacement status, mirroring the lifecycle reported by the
 * preview's HMR client over postMessage (`__hmr-status`).
 */
export type HmrStatus = 'connected' | 'disconnected' | 'building' | 'updated' | 'reloading' | 'error';

function isHmrStatus(value: unknown): value is HmrStatus {
	return (
		value === 'connected' ||
		value === 'disconnected' ||
		value === 'building' ||
		value === 'updated' ||
		value === 'reloading' ||
		value === 'error'
	);
}

const STATUS_PRESENTATION: Record<HmrStatus, { label: string; dotClassName: string }> = {
	connected: { label: 'HMR connected', dotClassName: 'bg-green-500' },
	disconnected: { label: 'HMR disconnected', dotClassName: 'bg-text-tertiary' },
	building: { label: 'Rebuilding…', dotClassName: 'bg-amber-500 animate-pulse' },
	updated: { label: 'Hot updated', dotClassName: 'bg-green-500' },
	reloading: { label: 'Reloading…', dotClassName: 'bg-amber-500 animate-pulse' },
	error: { label: 'Build error', dotClassName: 'bg-red-500' },
};

// How long the transient "updated" state stays visible before reverting to the
// steady connected state.
const UPDATED_RESET_MS = 1500;

export function HmrStatusIndicator() {
	const [status, setStatus] = useState<HmrStatus | undefined>();

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (!isMessageFromPreview(event)) {
				return;
			}
			const data: unknown = event.data;
			if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== '__hmr-status') {
				return;
			}
			if (!('status' in data) || !isHmrStatus(data.status)) {
				return;
			}
			setStatus(data.status);
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, []);

	useEffect(() => {
		if (status !== 'updated') {
			return;
		}
		const timer = setTimeout(() => setStatus('connected'), UPDATED_RESET_MS);
		return () => clearTimeout(timer);
	}, [status]);

	if (status === undefined) {
		return;
	}

	const presentation = STATUS_PRESENTATION[status];

	return (
		<Tooltip content={presentation.label}>
			<div className="flex items-center gap-1.5" aria-live="polite" aria-label={presentation.label} role="status">
				<span className={cn('size-1.5 rounded-full', presentation.dotClassName)} aria-hidden="true" />
			</div>
		</Tooltip>
	);
}
