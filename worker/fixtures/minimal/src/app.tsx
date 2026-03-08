import { useState, useEffect, useCallback } from 'react';

import { greet } from './utilities';

interface HelloResponse {
	message: string;
	timestamp: string;
}

export function App() {
	const [data, setData] = useState<HelloResponse | undefined>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');

	const fetchHello = useCallback(async () => {
		setLoading(true);
		setError('');
		try {
			const response = await fetch('/api/hello');
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const json: HelloResponse = await response.json();
			setData(json);
		} catch {
			setError('Failed to reach the worker API');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchHello();
	}, [fetchHello]);

	return (
		<div className="app">
			<h1>{greet('World')}</h1>
			<p className="subtitle">A minimal React + Hono starter on Cloudflare Workers</p>

			{error && <p className="error">{error}</p>}

			{loading && !data && <p className="loading">Loading...</p>}

			{data && (
				<div className="card">
					<p className="message">{data.message}</p>
					<p className="timestamp">Responded at {new Date(data.timestamp).toLocaleTimeString()}</p>
					<button className="btn-primary" onClick={fetchHello} disabled={loading}>
						{loading ? 'Refreshing...' : 'Refresh'}
					</button>
				</div>
			)}

			<p className="hint">
				Edit <code>src/app.tsx</code> for frontend, <code>worker/index.ts</code> for backend
			</p>
		</div>
	);
}
