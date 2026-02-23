/**
 * Version Badge
 *
 * Displays the app version (git commit SHA) as a small, subtle badge.
 * Shows a truncated hash, reveals the full hash on hover via tooltip,
 * and copies the full hash to clipboard on click with a success toast.
 *
 * Optionally fetches the Cloudflare deployment version at runtime
 * to enrich the tooltip with deployment metadata.
 */

import { useCallback, useEffect, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// =============================================================================
// Constants
// =============================================================================

/** Number of characters to show in the truncated version. */
const TRUNCATED_LENGTH = 7;

/** Build-time git commit SHA injected by Vite's `define`. */
const GIT_SHA = __APP_VERSION__;

// =============================================================================
// Types
// =============================================================================

interface CloudflareVersionMetadata {
	id: string;
	tag: string;
	timestamp: string;
}

// =============================================================================
// Hook: fetch CF deployment version
// =============================================================================

function useCloudflareVersion(): CloudflareVersionMetadata | undefined {
	const [metadata, setMetadata] = useState<CloudflareVersionMetadata | undefined>();

	useEffect(() => {
		let cancelled = false;

		void fetch('/api/version')
			.then((response) => {
				if (!response.ok) return;
				return response.json();
			})
			.then((data: CloudflareVersionMetadata | undefined) => {
				if (!cancelled && data?.id) {
					setMetadata(data);
				}
			})
			.catch(() => {
				// Silently ignore — CF version is optional enrichment
			});

		return () => {
			cancelled = true;
		};
	}, []);

	return metadata;
}

// =============================================================================
// Component
// =============================================================================

interface VersionBadgeProperties {
	/** Additional class names for the outer element. */
	className?: string;
	/**
	 * Whether to wrap in its own TooltipProvider.
	 * Set to `false` when rendered inside a parent that already provides one.
	 */
	withProvider?: boolean;
}

export function VersionBadge({ className, withProvider = true }: VersionBadgeProperties) {
	const cloudflareVersion = useCloudflareVersion();

	const truncated = GIT_SHA.slice(0, TRUNCATED_LENGTH);

	const tooltipContent = cloudflareVersion ? `${GIT_SHA}\nDeploy: ${cloudflareVersion.id.slice(0, TRUNCATED_LENGTH)}` : GIT_SHA;

	const handleClick = useCallback(() => {
		void navigator.clipboard.writeText(GIT_SHA).then(() => {
			toast.success('Version copied to clipboard');
		});
	}, []);

	const badge = (
		<Tooltip content={tooltipContent} side="top">
			<button
				type="button"
				onClick={handleClick}
				className={cn(
					'cursor-pointer font-mono text-xs text-text-secondary transition-colors',
					`
						hover:text-accent
						focus-visible:text-accent focus-visible:outline-none
					`,
					className,
				)}
				aria-label={`Version ${GIT_SHA}. Click to copy.`}
			>
				{truncated}
			</button>
		</Tooltip>
	);

	if (withProvider) {
		return <TooltipProvider>{badge}</TooltipProvider>;
	}

	return badge;
}
