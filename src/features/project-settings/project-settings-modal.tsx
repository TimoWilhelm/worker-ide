/**
 * Project Settings Modal
 *
 * Modal dialog for project-level meta settings.
 * Currently controls preview visibility (public/private).
 * Asset routing settings have moved to the inline wrangler.jsonc editor panel.
 */

import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { throwApiError } from '@/lib/api-error';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface ProjectSettingsModalProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
}

type Visibility = 'public' | 'private';

// =============================================================================
// API helpers (raw fetch — project-scoped endpoints)
// =============================================================================

async function fetchVisibility(projectId: string): Promise<Visibility> {
	const response = await fetch(`/p/${projectId}/api/project/visibility`);
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch visibility');
	}
	const data: { visibility: string } = await response.json();
	return data.visibility === 'private' ? 'private' : 'public';
}

async function updateVisibility(projectId: string, visibility: Visibility): Promise<void> {
	const response = await fetch(`/p/${projectId}/api/project/visibility`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ visibility }),
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to update visibility');
	}
}

// =============================================================================
// Component
// =============================================================================

export function ProjectSettingsModal({ open, onOpenChange, projectId }: ProjectSettingsModalProperties) {
	return (
		<Modal open={open} onOpenChange={onOpenChange} title="Project Settings" className="w-[420px]">
			{open && <ProjectSettingsContent onOpenChange={onOpenChange} projectId={projectId} />}
		</Modal>
	);
}

function ProjectSettingsContent({ onOpenChange, projectId }: { onOpenChange: (open: boolean) => void; projectId: string }) {
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const visibilityQuery = useQuery({
		queryKey: ['project-visibility', projectId],
		queryFn: () => fetchVisibility(projectId),
		staleTime: 0,
	});

	const [visibility, setVisibility] = useState<Visibility>('public');

	useEffect(() => {
		if (visibilityQuery.data) {
			setVisibility(visibilityQuery.data);
		}
	}, [visibilityQuery.data]);

	const handleSave = useCallback(async () => {
		setIsSaving(true);
		setError(undefined);
		try {
			await updateVisibility(projectId, visibility);
			onOpenChange(false);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to save settings';
			setError(message);
		} finally {
			setIsSaving(false);
		}
	}, [projectId, visibility, onOpenChange]);

	if (visibilityQuery.isLoading) {
		return (
			<ModalBody className="flex h-40 items-center justify-center">
				<Spinner size="md" />
			</ModalBody>
		);
	}

	return (
		<>
			<ModalBody className="flex flex-col gap-4">
				{error && (
					<div className="rounded-sm border border-red-500/30 bg-red-500/10 p-2.5">
						<p className="text-xs text-red-500">{error}</p>
					</div>
				)}

				<fieldset className="flex flex-col gap-2">
					<legend className="text-xs font-medium text-text-secondary">Preview Visibility</legend>
					<p className="text-xs text-text-secondary/70">Controls who can access the live preview of this project.</p>
					<div className="flex flex-col gap-1.5">
						<label
							className={cn(
								`
									flex cursor-pointer items-start gap-2.5 rounded-sm border p-2.5
									transition-colors
								`,
								visibility === 'public' ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
							)}
							htmlFor="vis-public"
						>
							<input
								id="vis-public"
								type="radio"
								name="visibility"
								value="public"
								checked={visibility === 'public'}
								onChange={() => setVisibility('public')}
								className="mt-0.5 accent-accent"
							/>
							<div className="flex flex-col gap-0.5">
								<span
									className="
										flex items-center gap-1.5 text-xs font-medium text-text-primary
									"
								>
									<Eye className="size-3.5" />
									Public
								</span>
								<span className="text-xs text-text-secondary/70">Anyone with the link can view the preview.</span>
							</div>
						</label>
						<label
							className={cn(
								`
									flex cursor-pointer items-start gap-2.5 rounded-sm border p-2.5
									transition-colors
								`,
								visibility === 'private' ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
							)}
							htmlFor="vis-private"
						>
							<input
								id="vis-private"
								type="radio"
								name="visibility"
								value="private"
								checked={visibility === 'private'}
								onChange={() => setVisibility('private')}
								className="mt-0.5 accent-accent"
							/>
							<div className="flex flex-col gap-0.5">
								<span
									className="
										flex items-center gap-1.5 text-xs font-medium text-text-primary
									"
								>
									<EyeOff className="size-3.5" />
									Private
								</span>
								<span className="text-xs text-text-secondary/70">Only organization members can view the preview.</span>
							</div>
						</label>
					</div>
				</fieldset>
			</ModalBody>
			<ModalFooter>
				<Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isSaving}>
					Cancel
				</Button>
				<Button onClick={handleSave} disabled={isSaving} isLoading={isSaving} loadingText="Saving...">
					Save
				</Button>
			</ModalFooter>
		</>
	);
}
