/**
 * React Application Entry Point
 *
 * This is the main entry point for the Worker IDE frontend.
 * It sets up React 19 with StrictMode and mounts the App component.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';

import './index.css';

const rootElement = document.querySelector('#root');

if (!rootElement) {
	throw new Error('Root element not found. Ensure index.html has a <div id="root"></div>');
}

createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
