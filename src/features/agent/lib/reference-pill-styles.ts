export const FILE_REFERENCE_BASE_CLASS_NAME = [
	'inline-flex max-w-full min-w-0 items-center gap-1 overflow-hidden rounded-sm px-1.5 py-px',
	'bg-accent/15 font-mono text-xs text-accent',
].join(' ');

export const FILE_REFERENCE_INTERACTIVE_CLASS_NAME = ['cursor-pointer transition-colors', 'hover:bg-accent/25'].join(' ');

export const FILE_REFERENCE_LABEL_CLASS_NAME = 'truncate';

export const PREVIEW_REFERENCE_BASE_CLASS_NAME = [
	'inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-full px-2 py-1',
	'border border-fuchsia-200 bg-linear-to-r from-rose-50 via-amber-50 to-sky-50',
	'dark:border-fuchsia-950 dark:from-fuchsia-950 dark:via-violet-950 dark:to-sky-950',
	'font-mono text-xs font-semibold text-slate-900',
	'shadow-[0_0_0_1px_rgba(255,255,255,0.03)] dark:text-slate-50',
].join(' ');

export const PREVIEW_REFERENCE_INTERACTIVE_CLASS_NAME = [
	'transition-colors',
	'hover:from-rose-100 hover:via-amber-100 hover:to-sky-100',
	'dark:hover:from-fuchsia-900 dark:hover:via-violet-900 dark:hover:to-sky-900',
].join(' ');

export const PREVIEW_REFERENCE_TEXT_ROW_CLASS_NAME = 'min-w-0 flex items-center gap-1.5 overflow-hidden';

export const PREVIEW_REFERENCE_LABEL_CLASS_NAME = 'max-w-full flex-none truncate whitespace-nowrap';

export const PREVIEW_REFERENCE_SUMMARY_CLASS_NAME = 'min-w-0 flex-1 truncate opacity-70';

export const PREVIEW_REFERENCE_ICON_CLASS_NAME = 'size-3 shrink-0 text-fuchsia-700 dark:text-fuchsia-300';

export const PREVIEW_REFERENCE_MISSING_CLASS_NAME = 'line-through opacity-65';
