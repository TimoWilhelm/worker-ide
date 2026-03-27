/* eslint-disable better-tailwindcss/no-unknown-classes */
/**
 * Custom Search Panel (React)
 *
 * React component rendered inside a CM6 panel via createRoot.
 * Uses the app's Tooltip component and Lucide icons.
 */

import {
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	replaceAll,
	replaceNext,
	SearchQuery,
	setSearchQuery,
} from '@codemirror/search';
import { ChevronDown, ChevronUp, Replace, ReplaceAll, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { EditorView } from '@codemirror/view';

// =============================================================================
// Types
// =============================================================================

type QuerySnapshot = { search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean };

interface SearchPanelProperties {
	view: EditorView;
	initialQuery: QuerySnapshot;
	/** Updated by the CM6 panel bridge when the query changes programmatically */
	externalQuery?: QuerySnapshot;
}

// =============================================================================
// Component
// =============================================================================

export function SearchPanelContent({ view, initialQuery, externalQuery }: SearchPanelProperties) {
	const [searchValue, setSearchValue] = useState(initialQuery.search);
	const [replaceValue, setReplaceValue] = useState(initialQuery.replace);
	const [caseSensitive, setCaseSensitive] = useState(initialQuery.caseSensitive);
	const [regexp, setRegexp] = useState(initialQuery.regexp);
	const [wholeWord, setWholeWord] = useState(initialQuery.wholeWord);
	const searchReference = useRef<HTMLInputElement>(null);

	// Sync state when the query is changed programmatically from outside
	const [previousExternalQuery, setPreviousExternalQuery] = useState(externalQuery);
	if (externalQuery && externalQuery !== previousExternalQuery) {
		setPreviousExternalQuery(externalQuery);
		if (externalQuery.search !== searchValue) setSearchValue(externalQuery.search);
		if (externalQuery.replace !== replaceValue) setReplaceValue(externalQuery.replace);
		if (externalQuery.caseSensitive !== caseSensitive) setCaseSensitive(externalQuery.caseSensitive);
		if (externalQuery.regexp !== regexp) setRegexp(externalQuery.regexp);
		if (externalQuery.wholeWord !== wholeWord) setWholeWord(externalQuery.wholeWord);
	}

	const commit = useCallback(
		(overrides?: { search?: string; replace?: string; caseSensitive?: boolean; regexp?: boolean; wholeWord?: boolean }) => {
			const newQuery = new SearchQuery({
				search: overrides?.search ?? searchValue,
				replace: overrides?.replace ?? replaceValue,
				caseSensitive: overrides?.caseSensitive ?? caseSensitive,
				regexp: overrides?.regexp ?? regexp,
				wholeWord: overrides?.wholeWord ?? wholeWord,
			});
			if (!newQuery.eq(getSearchQuery(view.state))) {
				view.dispatch({ effects: setSearchQuery.of(newQuery) });
			}
		},
		[view, searchValue, replaceValue, caseSensitive, regexp, wholeWord],
	);

	const handleSearchChange = useCallback(
		(value: string) => {
			setSearchValue(value);
			commit({ search: value });
		},
		[commit],
	);

	const handleReplaceChange = useCallback(
		(value: string) => {
			setReplaceValue(value);
			commit({ replace: value });
		},
		[commit],
	);

	const toggleCase = useCallback(() => {
		const next = !caseSensitive;
		setCaseSensitive(next);
		commit({ caseSensitive: next });
	}, [caseSensitive, commit]);

	const toggleRegexp = useCallback(() => {
		const next = !regexp;
		setRegexp(next);
		commit({ regexp: next });
	}, [regexp, commit]);

	const toggleWholeWord = useCallback(() => {
		const next = !wholeWord;
		setWholeWord(next);
		commit({ wholeWord: next });
	}, [wholeWord, commit]);

	const handleClose = useCallback(() => {
		closeSearchPanel(view);
		view.focus();
	}, [view]);

	const handleSearchKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === 'Enter' && event.shiftKey) {
				event.preventDefault();
				findPrevious(view);
			} else if (event.key === 'Enter') {
				event.preventDefault();
				findNext(view);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				handleClose();
			}
		},
		[view, handleClose],
	);

	const handleReplaceKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				replaceNext(view);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				handleClose();
			}
		},
		[view, handleClose],
	);

	useEffect(() => {
		searchReference.current?.focus();
		searchReference.current?.select();
	}, []);

	return (
		<TooltipProvider>
			<div className="cm-search-panel">
				{/* Row 1: Search */}
				<div className="cm-search-row">
					<div className="cm-search-input-wrap">
						<input
							ref={searchReference}
							className="cm-search-field"
							placeholder="Find"
							aria-label="Find"
							value={searchValue}
							onChange={(event) => handleSearchChange(event.target.value)}
							onKeyDown={handleSearchKeyDown}
						/>
						<div className="cm-search-toggles">
							<ToggleButton active={caseSensitive} onClick={toggleCase} tooltip="Match case">
								Aa
							</ToggleButton>
							<ToggleButton active={regexp} onClick={toggleRegexp} tooltip="Regular expression">
								.*
							</ToggleButton>
							<ToggleButton active={wholeWord} onClick={toggleWholeWord} tooltip="Match whole word">
								W
							</ToggleButton>
						</div>
					</div>
					<div className="cm-search-buttons">
						<IconButton onClick={() => findPrevious(view)} tooltip="Previous match (Shift+Enter)">
							<ChevronUp className="size-3.5" />
						</IconButton>
						<IconButton onClick={() => findNext(view)} tooltip="Next match (Enter)">
							<ChevronDown className="size-3.5" />
						</IconButton>
					</div>
					<IconButton onClick={handleClose} tooltip="Close (Escape)" variant="ghost">
						<X className="size-3.5" />
					</IconButton>
				</div>

				{/* Row 2: Replace */}
				<div className="cm-search-row">
					<div className="cm-search-input-wrap">
						<input
							className="cm-search-field"
							placeholder="Replace"
							aria-label="Replace"
							value={replaceValue}
							onChange={(event) => handleReplaceChange(event.target.value)}
							onKeyDown={handleReplaceKeyDown}
						/>
					</div>
					<div className="cm-search-buttons">
						<IconButton onClick={() => replaceNext(view)} tooltip="Replace next (Enter)">
							<Replace className="size-3.5" />
						</IconButton>
						<IconButton onClick={() => replaceAll(view)} tooltip="Replace all">
							<ReplaceAll className="size-3.5" />
						</IconButton>
					</div>
				</div>
			</div>
		</TooltipProvider>
	);
}

// =============================================================================
// Sub-components
// =============================================================================

function IconButton({
	children,
	onClick,
	tooltip,
	variant = 'outline',
}: {
	children: React.ReactNode;
	onClick: () => void;
	tooltip: string;
	variant?: 'outline' | 'ghost';
}) {
	return (
		<Tooltip content={tooltip} side="top" className="z-100">
			<Button variant={variant} size="icon-sm" onClick={onClick} aria-label={tooltip}>
				{children}
			</Button>
		</Tooltip>
	);
}

function ToggleButton({
	children,
	active,
	onClick,
	tooltip,
}: {
	children: React.ReactNode;
	active: boolean;
	onClick: () => void;
	tooltip: string;
}) {
	return (
		<Tooltip content={tooltip} side="top" className="z-100">
			<Button
				variant="ghost"
				onClick={onClick}
				aria-label={tooltip}
				aria-pressed={active}
				className={cn('h-5 w-6 px-0 font-mono text-2xs font-semibold', active ? 'text-accent' : 'opacity-50')}
			>
				{children}
			</Button>
		</Tooltip>
	);
}
