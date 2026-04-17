import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './app';

import './index.css';

// Safety net: reload once if a lazy-loaded chunk fails after a new deployment
globalThis.addEventListener('vite:preloadError', () => {
	const key = 'stale-asset-reload';
	const last = sessionStorage.getItem(key);
	if (last && Date.now() - Number(last) < 10_000) return;
	sessionStorage.setItem(key, String(Date.now()));
	globalThis.location.reload();
});

// WORKAROUND(react-resizable-panels): pointermove on iframes re-triggers
// separator hover via expanded hit regions. preventDefault skips the handler.
document.addEventListener(
	'pointermove',
	(event) => {
		if (event.target instanceof HTMLIFrameElement) event.preventDefault();
	},
	true,
);

const rootElement = document.querySelector('#root');

if (!rootElement) {
	throw new Error('Root element not found. Ensure index.html has a <div id="root"></div>');
}

createRoot(rootElement).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>,
);
