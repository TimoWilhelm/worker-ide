import { useState, useEffect, useCallback } from 'react';

interface InspectData {
	timestamp: string;
	method: string;
	url: string;
	headers: Record<string, string>;
	geo?: {
		country: string;
		city: string;
		continent: string;
		latitude: string;
		longitude: string;
		region: string;
		regionCode: string;
		postalCode: string;
		timezone: string;
		metroCode: string;
	};
	connection?: {
		colo: string;
		httpProtocol: string;
		tlsVersion: string;
		asn: string | number;
		asOrganization: string;
	};
	runtime: string;
}

interface EchoResponse {
	timestamp: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

const HIGHLIGHT_HEADERS = [
	'user-agent',
	'accept-language',
	'accept-encoding',
	'cf-connecting-ip',
	'cf-ipcountry',
	'cf-ray',
	'x-forwarded-for',
	'x-real-ip',
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="section">
			<h2>{title}</h2>
			{children}
		</div>
	);
}

function KeyValue({ label, value }: { label: string; value: string }) {
	return (
		<div className="kv-row">
			<span className="kv-label">{label}</span>
			<span className="kv-value">{value}</span>
		</div>
	);
}

function SkeletonLine({ width = '60%' }: { width?: string }) {
	return (
		<div className="kv-row">
			<span className="skeleton" style={{ width: '120px', height: '0.85em' }} />
			<span className="skeleton" style={{ width, height: '0.85em' }} />
		</div>
	);
}

function SkeletonCard({ lines = 3 }: { lines?: number }) {
	const widths = ['75%', '50%', '90%', '60%', '40%'];
	return (
		<div className="card">
			{Array.from({ length: lines }, (_, index) => (
				<SkeletonLine key={index} width={widths[index % widths.length]} />
			))}
		</div>
	);
}

export function App() {
	const [data, setData] = useState<InspectData | undefined>();
	const [echoInput, setEchoInput] = useState('{ "hello": "world" }');
	const [echoResult, setEchoResult] = useState<EchoResponse | undefined>();
	const [echoError, setEchoError] = useState('');
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');

	const fetchInspect = useCallback(async () => {
		setLoading(true);
		setError('');
		try {
			const response = await fetch('/api/inspect');
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const json: InspectData = await response.json();
			setData(json);
		} catch {
			setError('Failed to reach the worker API');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchInspect();
	}, [fetchInspect]);

	const handleEcho = async () => {
		setEchoResult(undefined);
		setEchoError('');
		try {
			const response = await fetch('/api/echo', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: echoInput,
			});
			if (!response.ok) {
				const errorBody: { error?: string } = await response.json();
				throw new Error(errorBody.error ?? `HTTP ${response.status}`);
			}
			const json: EchoResponse = await response.json();
			setEchoResult(json);
		} catch (error_) {
			setEchoError(error_ instanceof Error ? error_.message : 'Request failed');
		}
	};

	return (
		<div className="app">
			<h1>&#128269; Request Inspector</h1>
			<p className="subtitle">See what your Cloudflare Worker knows about each request</p>

			{error && <p className="error">{error}</p>}

			{loading && !data && (
				<>
					<SkeletonCard lines={2} />
					<Section title="Geolocation">
						<SkeletonCard lines={5} />
					</Section>
					<Section title="Request Headers">
						<SkeletonCard lines={4} />
					</Section>
				</>
			)}

			{data && (
				<>
					<div className="card">
						<div className="card-header">
							<span className="status">Responded at {new Date(data.timestamp).toLocaleTimeString()}</span>
							<button className="btn-primary" onClick={fetchInspect} disabled={loading}>
								{loading ? 'Refreshing...' : 'Refresh'}
							</button>
						</div>

						<KeyValue label="Runtime" value={data.runtime} />
						<KeyValue label="Request URL" value={data.url} />
					</div>

					{data.geo && (
						<Section title="Geolocation">
							<div className="card">
								<KeyValue label="Country" value={data.geo.country} />
								<KeyValue label="City" value={data.geo.city} />
								<KeyValue label="Region" value={`${data.geo.region} (${data.geo.regionCode})`} />
								<KeyValue label="Continent" value={data.geo.continent} />
								<KeyValue label="Timezone" value={data.geo.timezone} />
								<KeyValue label="Coordinates" value={`${data.geo.latitude}, ${data.geo.longitude}`} />
								<KeyValue label="Postal Code" value={data.geo.postalCode} />
							</div>
						</Section>
					)}

					{data.connection && (
						<Section title="Connection">
							<div className="card">
								<KeyValue label="Cloudflare Colo" value={data.connection.colo} />
								<KeyValue label="HTTP Protocol" value={data.connection.httpProtocol} />
								<KeyValue label="TLS Version" value={data.connection.tlsVersion} />
								<KeyValue label="ASN" value={String(data.connection.asn)} />
								<KeyValue label="AS Organization" value={data.connection.asOrganization} />
							</div>
						</Section>
					)}

					{!data.geo && !data.connection && (
						<Section title="Edge Info">
							<div className="card">
								<p className="muted">Cloudflare geolocation and connection data is available when deployed to the Cloudflare network.</p>
							</div>
						</Section>
					)}

					<Section title="Request Headers">
						<div className="card">
							{HIGHLIGHT_HEADERS.filter((h) => data.headers[h]).map((h) => (
								<KeyValue key={h} label={h} value={data.headers[h]} />
							))}
							{Object.entries(data.headers)
								.filter(([key]) => !HIGHLIGHT_HEADERS.includes(key))
								.map(([key, value]) => (
									<KeyValue key={key} label={key} value={value} />
								))}
						</div>
					</Section>
				</>
			)}

			<Section title="Echo API">
				<div className="card">
					<p className="muted">
						Send JSON to <code>POST /api/echo</code> and see it reflected back from the server.
					</p>
					<textarea className="echo-input" rows={4} value={echoInput} onChange={(event) => setEchoInput(event.target.value)} />
					<button className="btn-primary" onClick={handleEcho}>
						Send
					</button>
					{echoError && <p className="error">{echoError}</p>}
					{echoResult && <pre className="echo-result">{JSON.stringify(echoResult, undefined, 2)}</pre>}
				</div>
			</Section>

			<p className="hint">
				Edit <code>src/app.tsx</code> for frontend, <code>worker/index.ts</code> for backend
			</p>
		</div>
	);
}
