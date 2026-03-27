/**
 * Custom Search Panel for CodeMirror 6
 *
 * Bridges CM6's panel API with a React component via createRoot.
 * The panel factory creates a DOM container, renders the React
 * SearchPanelContent into it, and unmounts on destroy.
 */

import { getSearchQuery, search, setSearchQuery } from '@codemirror/search';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { SearchPanelContent } from '../components/search-panel';

import type { Extension } from '@codemirror/state';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';

function createSearchPanel(view: EditorView): Panel {
	const dom = document.createElement('div');
	dom.style.minHeight = '58px';
	let root: ReturnType<typeof createRoot> | undefined;

	function getQuerySnapshot() {
		const query = getSearchQuery(view.state);
		return {
			search: query.search,
			replace: query.replace,
			caseSensitive: query.caseSensitive,
			regexp: query.regexp,
			wholeWord: query.wholeWord,
		};
	}

	function renderPanel(querySnapshot: ReturnType<typeof getQuerySnapshot>) {
		root?.render(
			createElement(SearchPanelContent, {
				view,
				initialQuery: querySnapshot,
				externalQuery: querySnapshot,
			}),
		);
	}

	return {
		dom,
		top: false,
		mount() {
			root = createRoot(dom);
			renderPanel(getQuerySnapshot());
		},
		update(update: ViewUpdate) {
			if (update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setSearchQuery)))) {
				renderPanel(getQuerySnapshot());
			}
		},
		destroy() {
			const rootToUnmount = root;
			root = undefined;
			queueMicrotask(() => rootToUnmount?.unmount());
		},
	};
}

/**
 * Create the search extension with custom panel layout.
 */
export function createSearchExtension(): Extension {
	return search({ createPanel: createSearchPanel });
}
