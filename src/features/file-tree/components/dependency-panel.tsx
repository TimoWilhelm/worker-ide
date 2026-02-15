/**
 * Dependency Panel
 *
 * Collapsible panel below the file tree for managing project dependencies.
 */

import { AlertTriangle, ChevronDown, ChevronUp, Package, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchProjectMeta, updateDependencies } from '@/lib/api-client';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface DependencyPanelProperties {
	projectId: string;
	/** When true, render only the collapsed header bar */
	collapsed?: boolean;
	/** Called when the user clicks the header to expand/collapse */
	onToggle?: () => void;
	className?: string;
}

interface DependencyEntry {
	name: string;
	version: string;
}

// =============================================================================
// Component
// =============================================================================

function DependencyPanel({ projectId, collapsed = false, onToggle, className }: DependencyPanelProperties) {
	const [dependencies, setDependencies] = useState<DependencyEntry[]>([]);
	const [isAdding, setIsAdding] = useState(false);
	const [editingName, setEditingName] = useState<string | undefined>();
	const [addInput, setAddInput] = useState('');
	const [editVersion, setEditVersion] = useState('');
	const [isLoading, setIsLoading] = useState(false);
	const [missingDependencies, setMissingDependencies] = useState<Set<string>>(new Set());
	const nameInputReference = useRef<HTMLInputElement>(null);
	const editInputReference = useRef<HTMLInputElement>(null);

	// Listen for server-error events to detect missing dependencies
	useEffect(() => {
		const pattern = /Unregistered dependency "([^"]+)"/;
		const handleServerError = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const message: string = event.detail?.message ?? '';
			const match = pattern.exec(message);
			if (match?.[1]) {
				setMissingDependencies((previous) => {
					const next = new Set(previous);
					next.add(match[1]);
					return next;
				});
				if (collapsed && onToggle) onToggle();
			}
		};
		globalThis.addEventListener('server-error', handleServerError);
		return () => globalThis.removeEventListener('server-error', handleServerError);
	}, [collapsed, onToggle]);

	// Load dependencies from project meta
	const loadDependencies = useCallback(async () => {
		try {
			const meta = await fetchProjectMeta(projectId);
			const dependencyRecord = meta.dependencies ?? {};
			const entries = Object.entries(dependencyRecord)
				.map(([name, version]) => ({ name, version }))
				.toSorted((a, b) => a.name.localeCompare(b.name));
			setDependencies(entries);
		} catch {
			// Ignore errors on initial load
		}
	}, [projectId]);

	useEffect(() => {
		void loadDependencies();
	}, [loadDependencies]);

	// Focus name input when adding
	useEffect(() => {
		if (isAdding && nameInputReference.current) {
			nameInputReference.current.focus();
		}
	}, [isAdding]);

	// Focus edit input when editing
	useEffect(() => {
		if (editingName && editInputReference.current) {
			editInputReference.current.focus();
			editInputReference.current.select();
		}
	}, [editingName]);

	const saveDependencies = useCallback(
		async (entries: DependencyEntry[]) => {
			setIsLoading(true);
			try {
				const record: Record<string, string> = {};
				for (const entry of entries) {
					record[entry.name] = entry.version;
				}
				await updateDependencies(projectId, record);
				setDependencies(entries.toSorted((a, b) => a.name.localeCompare(b.name)));
			} catch {
				// Revert on error
				await loadDependencies();
			} finally {
				setIsLoading(false);
			}
		},
		[projectId, loadDependencies],
	);

	const parseAddInput = useCallback((input: string): { name: string; version: string } | undefined => {
		const trimmed = input.trim();
		if (!trimmed) return undefined;
		// Support scoped packages: @scope/name@version
		const atIndex = trimmed.startsWith('@') ? trimmed.indexOf('@', 1) : trimmed.indexOf('@');
		if (atIndex > 0) {
			return { name: trimmed.slice(0, atIndex), version: trimmed.slice(atIndex + 1) || '*' };
		}
		return { name: trimmed, version: '*' };
	}, []);

	const handleAdd = useCallback(async () => {
		const parsed = parseAddInput(addInput);
		if (!parsed) return;
		if (dependencies.some((d) => d.name === parsed.name)) return;

		const updated = [...dependencies, parsed];
		setIsAdding(false);
		setAddInput('');
		setMissingDependencies((previous) => {
			const next = new Set(previous);
			next.delete(parsed.name);
			return next;
		});
		await saveDependencies(updated);
	}, [addInput, parseAddInput, dependencies, saveDependencies]);

	const handleAddMissing = useCallback(
		async (name: string) => {
			if (dependencies.some((d) => d.name === name)) {
				setMissingDependencies((previous) => {
					const next = new Set(previous);
					next.delete(name);
					return next;
				});
				return;
			}
			const updated = [...dependencies, { name, version: '*' }];
			setMissingDependencies((previous) => {
				const next = new Set(previous);
				next.delete(name);
				return next;
			});
			await saveDependencies(updated);
		},
		[dependencies, saveDependencies],
	);

	const handleRemove = useCallback(
		async (name: string) => {
			const updated = dependencies.filter((d) => d.name !== name);
			await saveDependencies(updated);
		},
		[dependencies, saveDependencies],
	);

	const handleEditStart = useCallback(
		(name: string) => {
			const entry = dependencies.find((d) => d.name === name);
			if (entry) {
				setEditingName(name);
				setEditVersion(entry.version);
			}
		},
		[dependencies],
	);

	const handleEditSave = useCallback(async () => {
		if (!editingName) return;
		const updated = dependencies.map((d) => (d.name === editingName ? { ...d, version: editVersion.trim() || '*' } : d));
		setEditingName(undefined);
		setEditVersion('');
		await saveDependencies(updated);
	}, [editingName, editVersion, dependencies, saveDependencies]);

	const handleAddKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === 'Enter') {
				void handleAdd();
			} else if (event.key === 'Escape') {
				setIsAdding(false);
				setAddInput('');
			}
		},
		[handleAdd],
	);

	const handleEditKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === 'Enter') {
				void handleEditSave();
			} else if (event.key === 'Escape') {
				setEditingName(undefined);
				setEditVersion('');
			}
		},
		[handleEditSave],
	);

	if (collapsed) {
		return (
			<button
				type="button"
				onClick={onToggle}
				className={cn(
					'flex h-7 w-full shrink-0 cursor-pointer items-center gap-1 px-2 text-2xs',
					'border-t border-border bg-bg-secondary font-medium tracking-wider',
					'text-text-secondary uppercase',
					'hover:bg-bg-tertiary hover:text-text-primary',
					className,
				)}
				aria-label="Show dependencies"
			>
				<ChevronUp className="size-3.5" />
				<Package className="size-3" />
				<span className="flex-1 text-left">Dependencies</span>
				<span className="text-3xs text-text-secondary tabular-nums">{dependencies.length}</span>
			</button>
		);
	}

	return (
		<div className={cn('flex flex-col', className)}>
			{/* Header */}
			<button
				type="button"
				onClick={onToggle}
				className={`
					flex h-7 shrink-0 cursor-pointer items-center gap-1 px-2 text-2xs
					font-medium tracking-wider text-text-secondary uppercase
					hover:text-text-primary
				`}
			>
				<ChevronDown className="size-3.5" />
				<Package className="size-3" />
				<span className="flex-1 text-left">Dependencies</span>
				<span className="text-3xs text-text-secondary tabular-nums">{dependencies.length}</span>
			</button>

			<div className="flex flex-col gap-0.5 px-1 pb-1.5">
				{/* Add dependency — inline input or button */}
				{isAdding ? (
					<input
						ref={nameInputReference}
						type="text"
						value={addInput}
						onChange={(event) => setAddInput(event.target.value)}
						onKeyDown={handleAddKeyDown}
						onBlur={() => {
							if (!addInput.trim()) {
								setIsAdding(false);
								setAddInput('');
							}
						}}
						placeholder="name or name@version"
						className={`
							h-6 rounded-sm border border-accent bg-bg-primary px-1.5 text-2xs
							text-text-primary outline-none
						`}
					/>
				) : (
					<button
						type="button"
						onClick={() => setIsAdding(true)}
						disabled={isLoading}
						className={`
							flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-2xs
							text-text-secondary
							hover:bg-bg-tertiary hover:text-text-primary
							disabled:opacity-50
						`}
					>
						<Plus className="size-3" />
						<span>Add dependency</span>
					</button>
				)}

				{/* Missing dependencies */}
				{missingDependencies.size > 0 && (
					<div
						className={`
							flex flex-col gap-0.5 rounded-sm border border-warning/30 bg-warning/5
							p-1
						`}
					>
						<span className="flex items-center gap-1 px-0.5 text-3xs text-warning">
							<AlertTriangle className="size-3" />
							Missing
						</span>
						{[...missingDependencies].map((name) => (
							<button
								key={name}
								type="button"
								onClick={() => void handleAddMissing(name)}
								disabled={isLoading}
								className={`
									flex h-5 cursor-pointer items-center gap-1 rounded-sm px-1 text-2xs
									text-warning
									hover:bg-warning/10
									disabled:opacity-50
								`}
							>
								<Plus className="size-2.5" />
								<span className="flex-1 truncate text-left">{name}</span>
								<span className="text-3xs opacity-60">@*</span>
							</button>
						))}
					</div>
				)}

				{/* Dependency list */}
				{dependencies.map((entry) => (
					<div
						key={entry.name}
						className={`
							group flex h-6 items-center gap-1 rounded-sm px-1.5 text-2xs
							hover:bg-bg-tertiary
						`}
					>
						{editingName === entry.name ? (
							<>
								<span className="shrink-0 text-text-primary">{entry.name}@</span>
								<input
									ref={editInputReference}
									type="text"
									value={editVersion}
									onChange={(event) => setEditVersion(event.target.value)}
									onKeyDown={handleEditKeyDown}
									onBlur={() => void handleEditSave()}
									className={`
										h-5 min-w-0 flex-1 rounded-sm border border-border bg-bg-primary px-1
										text-2xs text-text-primary outline-none
										focus:border-accent
									`}
								/>
							</>
						) : (
							<>
								<span className="min-w-0 flex-1 truncate text-text-primary">
									{entry.name}
									<span className="text-text-secondary">@{entry.version}</span>
								</span>
								<button
									type="button"
									onClick={() => handleEditStart(entry.name)}
									className={`
										hidden size-4 shrink-0 cursor-pointer items-center justify-center
										rounded-sm text-text-secondary
										group-hover:flex
										hover:text-text-primary
									`}
								>
									<Pencil className="size-2.5" />
								</button>
								<button
									type="button"
									onClick={() => void handleRemove(entry.name)}
									className={`
										hidden size-4 shrink-0 cursor-pointer items-center justify-center
										rounded-sm text-text-secondary
										group-hover:flex
										hover:text-error
									`}
								>
									<Trash2 className="size-2.5" />
								</button>
							</>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

export { DependencyPanel };
export type { DependencyPanelProperties };
