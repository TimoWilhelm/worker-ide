/**
 * Dependency Panel
 *
 * Collapsible panel below the file tree for managing project dependencies.
 */

import { AlertTriangle, ChevronDown, ChevronUp, Package, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchProjectMeta, updateDependencies } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { validateDependencyName, validateDependencyVersion } from '@shared/validation';

import type { DependencyError } from '@shared/types';

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
	const [invalidDependencies, setInvalidDependencies] = useState<Map<string, string>>(new Map());
	const [addError, setAddError] = useState<string | undefined>();
	const [editError, setEditError] = useState<string | undefined>();
	const nameInputReference = useRef<HTMLInputElement>(null);
	const editInputReference = useRef<HTMLInputElement>(null);

	// Listen for server-error events to detect missing or invalid dependencies.
	// Errors arrive via two channels:
	//   1. WebSocket server-error → CustomEvent('server-error')
	//   2. Preview iframe postMessage → MessageEvent with type '__server-error'
	// The WebSocket path deduplicates, so on refresh the same error may only
	// arrive via the iframe postMessage path.
	useEffect(() => {
		const ERROR_MESSAGES: Record<DependencyError['code'], string> = {
			unregistered: 'Not registered. Add it via the Dependencies panel.',
			'not-found': 'Package not found. Check the name and version.',
			'resolve-failed': 'Failed to resolve from CDN. The version may be invalid.',
		};

		function processDependencyErrors(errors: DependencyError[]) {
			let hasChanges = false;
			for (const depError of errors) {
				if (depError.code === 'unregistered') {
					setMissingDependencies((previous) => {
						const next = new Set(previous);
						next.add(depError.packageName);
						return next;
					});
					hasChanges = true;
				} else {
					setInvalidDependencies((previous) => {
						const next = new Map(previous);
						next.set(depError.packageName, ERROR_MESSAGES[depError.code]);
						return next;
					});
					hasChanges = true;
				}
			}
			if (hasChanges && collapsed && onToggle) onToggle();
		}

		function extractDependencyErrors(errorObject: unknown): DependencyError[] | undefined {
			if (typeof errorObject !== 'object' || errorObject === undefined || errorObject === null) {
				return undefined;
			}
			if (!('dependencyErrors' in errorObject)) return undefined;
			const { dependencyErrors } = errorObject;
			if (!Array.isArray(dependencyErrors)) return undefined;
			return dependencyErrors;
		}

		// Channel 1: WebSocket server-error dispatched as CustomEvent
		const handleServerError = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const errors = extractDependencyErrors(event.detail);
			if (errors) processDependencyErrors(errors);
		};

		// Channel 2: Preview iframe postMessage (__server-error)
		const handleMessage = (event: MessageEvent) => {
			if (event.origin !== globalThis.location.origin) return;
			if (event.data?.type !== '__server-error') return;
			const errors = extractDependencyErrors(event.data?.error);
			if (errors) processDependencyErrors(errors);
		};

		globalThis.addEventListener('server-error', handleServerError);
		globalThis.addEventListener('message', handleMessage);
		return () => {
			globalThis.removeEventListener('server-error', handleServerError);
			globalThis.removeEventListener('message', handleMessage);
		};
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

		// Validate name
		const nameError = validateDependencyName(parsed.name);
		if (nameError) {
			setAddError(nameError);
			return;
		}

		// Validate version
		const versionError = validateDependencyVersion(parsed.version);
		if (versionError) {
			setAddError(versionError);
			return;
		}

		if (dependencies.some((d) => d.name === parsed.name)) {
			setAddError(`"${parsed.name}" is already added. Edit its version instead.`);
			return;
		}

		const updated = [...dependencies, parsed];
		setIsAdding(false);
		setAddInput('');
		setAddError(undefined);
		setMissingDependencies((previous) => {
			const next = new Set(previous);
			next.delete(parsed.name);
			return next;
		});
		setInvalidDependencies((previous) => {
			const next = new Map(previous);
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
		const version = editVersion.trim() || '*';

		// Validate version
		const versionError = validateDependencyVersion(version);
		if (versionError) {
			setEditError(versionError);
			return;
		}

		const updated = dependencies.map((d) => (d.name === editingName ? { ...d, version } : d));
		setEditingName(undefined);
		setEditVersion('');
		setEditError(undefined);
		setInvalidDependencies((previous) => {
			const next = new Map(previous);
			next.delete(editingName);
			return next;
		});
		await saveDependencies(updated);
	}, [editingName, editVersion, dependencies, saveDependencies]);

	const handleAddKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === 'Enter') {
				void handleAdd();
			} else if (event.key === 'Escape') {
				setIsAdding(false);
				setAddInput('');
				setAddError(undefined);
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
				setEditError(undefined);
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
					<div className="flex flex-col gap-0.5">
						<input
							ref={nameInputReference}
							type="text"
							value={addInput}
							onChange={(event) => {
								setAddInput(event.target.value);
								setAddError(undefined);
							}}
							onKeyDown={handleAddKeyDown}
							onBlur={() => {
								if (!addInput.trim()) {
									setIsAdding(false);
									setAddInput('');
									setAddError(undefined);
								}
							}}
							placeholder="name or name@version"
							aria-invalid={addError !== undefined}
							className={cn(
								`
									h-6 rounded-sm border bg-bg-primary px-1.5 text-2xs text-text-primary
									outline-none
								`,
								addError ? 'border-error' : 'border-accent',
							)}
						/>
						{addError && (
							<span role="alert" className="px-1 text-3xs/tight text-error">
								{addError}
							</span>
						)}
					</div>
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
				{dependencies.map((entry, index) => {
					const dependencyError = invalidDependencies.get(entry.name);
					const isInvalid = dependencyError !== undefined;
					return (
						<div key={entry.name} className="flex flex-col">
							<div
								role="option"
								tabIndex={index === 0 ? 0 : -1}
								aria-selected={editingName === entry.name}
								aria-invalid={isInvalid}
								onKeyDown={(event) => {
									const row = event.currentTarget;
									switch (event.key) {
										case 'ArrowDown': {
											event.preventDefault();
											const next = row.parentElement?.nextElementSibling?.querySelector('[role="option"]');
											if (next instanceof HTMLElement) next.focus();
											break;
										}
										case 'ArrowUp': {
											event.preventDefault();
											const previous = row.parentElement?.previousElementSibling?.querySelector('[role="option"]');
											if (previous instanceof HTMLElement) previous.focus();
											break;
										}
										case 'Enter':
										case 'F2': {
											event.preventDefault();
											handleEditStart(entry.name);
											break;
										}
										case 'Delete': {
											event.preventDefault();
											void handleRemove(entry.name);
											break;
										}
										default: {
											break;
										}
									}
								}}
								className={cn(
									'group flex h-6 items-center gap-1 rounded-sm px-1.5 text-2xs',
									'hover:bg-bg-tertiary',
									`
										focus-visible:ring-1 focus-visible:ring-accent
										focus-visible:outline-none
									`,
									isInvalid && 'bg-error/5',
								)}
							>
								{editingName === entry.name ? (
									<>
										<span className="shrink-0 text-text-primary">{entry.name}@</span>
										<input
											ref={editInputReference}
											type="text"
											value={editVersion}
											onChange={(event) => {
												setEditVersion(event.target.value);
												setEditError(undefined);
											}}
											onKeyDown={handleEditKeyDown}
											onBlur={() => void handleEditSave()}
											aria-invalid={editError !== undefined}
											className={cn(
												'h-5 min-w-0 flex-1 rounded-sm border bg-bg-primary px-1',
												'text-2xs text-text-primary outline-none',
												editError
													? 'border-error'
													: `
														border-border
														focus:border-accent
													`,
											)}
										/>
									</>
								) : (
									<>
										{isInvalid && <AlertTriangle className="size-3 shrink-0 text-error" />}
										<span className={cn('min-w-0 flex-1 truncate', isInvalid ? 'text-error' : 'text-text-primary')}>
											{entry.name}
											<span className={cn(isInvalid ? 'text-error/70' : 'text-text-secondary')}>@{entry.version}</span>
										</span>
										<button
											type="button"
											tabIndex={-1}
											onClick={() => handleEditStart(entry.name)}
											aria-label={`Edit version for ${entry.name}`}
											className={`
												flex size-4 shrink-0 cursor-pointer items-center justify-center
												rounded-sm text-text-secondary opacity-0 transition-colors
												hover-always:text-text-primary
												group-hover-always:opacity-100
											`}
										>
											<Pencil className="size-2.5" />
										</button>
										<button
											type="button"
											tabIndex={-1}
											onClick={() => void handleRemove(entry.name)}
											aria-label={`Remove ${entry.name}`}
											className={`
												flex size-4 shrink-0 cursor-pointer items-center justify-center
												rounded-sm text-text-secondary opacity-0 transition-colors
												hover-always:text-error
												group-hover-always:opacity-100
											`}
										>
											<Trash2 className="size-2.5" />
										</button>
									</>
								)}
							</div>
							{editingName === entry.name && editError && (
								<span role="alert" className="px-1.5 text-3xs/tight text-error">
									{editError}
								</span>
							)}
							{isInvalid && editingName !== entry.name && <span className="px-1.5 text-3xs/tight text-error">{dependencyError}</span>}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export { DependencyPanel };
export type { DependencyPanelProperties };
