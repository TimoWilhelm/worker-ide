/**
 * Hook for managing the project name state: fetching, editing, and renaming.
 */

import { useQuery } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { fetchProjectMeta, updateProjectMeta } from '@/lib/api-client';

export function useProjectName({ projectId }: { projectId: string }) {
	// Fetch project meta via React Query
	const metaQuery = useQuery({
		queryKey: ['project-meta', projectId],
		queryFn: () => fetchProjectMeta(projectId),
		staleTime: 1000 * 60,
	});

	const [localName, setLocalName] = useState<string | undefined>();
	const projectName = localName ?? metaQuery.data?.name;
	const [isEditingName, setIsEditingName] = useState(false);
	const [editNameValue, setEditNameValue] = useState('');
	const nameInputReference = useRef<HTMLInputElement>(null);

	const handleStartRename = useCallback(() => {
		setEditNameValue(projectName ?? '');
		setIsEditingName(true);
		requestAnimationFrame(() => {
			nameInputReference.current?.focus();
			nameInputReference.current?.select();
		});
	}, [projectName]);

	const handleSaveRename = useCallback(async () => {
		const trimmed = editNameValue.trim();
		if (trimmed && trimmed !== projectName) {
			const previousName = localName;
			setLocalName(trimmed);
			try {
				await updateProjectMeta(projectId, trimmed);
			} catch {
				setLocalName(previousName);
				toast.error('Failed to rename project');
			}
		}
		setIsEditingName(false);
	}, [editNameValue, projectName, localName, projectId]);

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
