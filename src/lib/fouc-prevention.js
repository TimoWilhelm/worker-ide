// Prevent flash of wrong theme/font by applying persisted preferences before first paint.
// Reads from "worker-ide-preferences" — the single global user preferences cache.
// __DEFAULT_EDITOR_FONT__ and __EDITOR_FONT_FAMILIES__ are replaced at build time
// by foucPreventionPlugin — see vite.config.ts and shared/constants/editor-fonts.ts.
try {
	var p = JSON.parse(localStorage.getItem('worker-ide-preferences') || '{}');
	var c = p.colorScheme || 'dark';
	if (c === 'system') c = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	if (c !== 'dark') document.documentElement.classList.remove('dark');
	document.documentElement.style.backgroundColor = c === 'dark' ? '#121212' : '#fffdfb';
	var f = p.editorFont || __DEFAULT_EDITOR_FONT__;
	var fonts = __EDITOR_FONT_FAMILIES__;
	if (fonts[f]) document.documentElement.style.setProperty('--font-mono', fonts[f]);
} catch {}
