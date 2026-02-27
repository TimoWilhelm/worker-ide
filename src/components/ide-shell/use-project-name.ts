/**
 * Hook for managing the project name state: fetching, editing, and renaming.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { fetchProjectMeta, updateProjectMeta } from '@/lib/api-client';
import { trackProject } from '@/lib/recent-projects';

export function useProjectName({ projectId }: { projectId: string }) {
	const [projectName, setProjectName] = useState<string | undefined>();
	const [isEditingName, setIsEditingName] = useState(false);
	const [editNameValue, setEditNameValue] = useState('');
	const nameInputReference = useRef<HTMLInputElement>(null);

	// Fetch project meta on mount
	useEffect(() => {
		void (async () => {
			try {
				const meta = await fetchProjectMeta(projectId);
				setProjectName(meta.name);
				trackProject(projectId, meta.name);
			} catch {
				// Project meta not available, use fallback
			}
		})();
	}, [projectId]);

	// Focus name input when editing starts
	useEffect(() => {
		if (isEditingName) {
			nameInputReference.current?.focus();
			nameInputReference.current?.select();
		}
	}, [isEditingName]);

	const handleStartRename = useCallback(() => {
		setEditNameValue(projectName ?? '');
		setIsEditingName(true);
	}, [projectName]);

	const handleSaveRename = useCallback(async () => {
		const trimmed = editNameValue.trim();
		if (trimmed && trimmed !== projectName) {
			const previousName = projectName;
			setProjectName(trimmed);
			trackProject(projectId, trimmed);
			try {
				await updateProjectMeta(projectId, trimmed);
			} catch {
				setProjectName(previousName);
				toast.error('Failed to rename project');
			}
		}
		setIsEditingName(false);
	}, [editNameValue, projectName, projectId]);

	const handleCancelRename = useCallback(() => {
		setIsEditingName(false);
	}, []);

	return {
		projectName,
		isEditingName,
		editNameValue,
		setEditNameValue,
		nameInputReference,
		handleStartRename,
		handleSaveRename,
		handleCancelRename,
	};
}
