// Prevent flash of wrong theme/font by applying persisted preferences before first paint.
// Reads from two localStorage sources:
//   1. "worker-ide-preferences" — global user preferences cache (synced from server)
//   2. "worker-ide-store" — per-session Zustand store (fallback for first load)
// __DEFAULT_EDITOR_FONT__ and __EDITOR_FONT_FAMILIES__ are replaced at build time
// by foucPreventionPlugin — see vite.config.ts and shared/constants/editor-fonts.ts.
try {
	var p = JSON.parse(localStorage.getItem('worker-ide-preferences') || '{}');
	var s = JSON.parse(localStorage.getItem('worker-ide-store') || '{}');
	var c = p.colorScheme || (s.state && s.state.colorScheme) || 'dark';
	if (c === 'system') c = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	if (c !== 'dark') document.documentElement.classList.remove('dark');
	var f = p.editorFont || (s.state && s.state.editorFont) || __DEFAULT_EDITOR_FONT__;
	var fonts = __EDITOR_FONT_FAMILIES__;
	if (fonts[f]) document.documentElement.style.setProperty('--font-mono', fonts[f]);
} catch {}
