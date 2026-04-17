import { useEffect } from 'react';

import { selectEditorFont, useStore } from '@/lib/store';
import { EDITOR_FONT_FAMILIES } from '@shared/constants';

import type { EditorFont } from '@shared/constants';

/**
 * Keeps the `--font-mono` CSS custom property in sync with the store.
 * Call once near the app root (e.g. alongside `useTheme()`).
 */
export function useEditorFont(): EditorFont {
	const editorFont = useStore(selectEditorFont);

	useEffect(() => {
		document.documentElement.style.setProperty('--font-mono', EDITOR_FONT_FAMILIES[editorFont]);
	}, [editorFont]);

	return editorFont;
}
