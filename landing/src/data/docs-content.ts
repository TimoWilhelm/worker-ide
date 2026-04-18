// ── Flow diagram data model ──────────────────────────────

export interface GraphNode {
	id: string;
	name: string;
	detail: string;
	color: string;
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	label: string;
	color: string;
}

export interface FlowSection {
	label?: string;
	labelColor?: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface DocsTopic {
	slug: string;
	title: string;
	description: string;
	tagline: string;
	accent: string;
	laneDescription: string;
	sections: FlowSection[];
	notes: string[];
}

// ── All 10 topics ────────────────────────────────────────

export const docsTopics: DocsTopic[] = [
	// 1. Asset Pipeline + HMR
	{
		slug: 'asset-pipeline',
		title: 'Asset Pipeline + HMR',
		description: 'How file edits move from the editor to preview with durable persistence and low-latency hot updates.',
		tagline: 'Save file → durable write → HMR event → preview module reload',
		accent: 'asset',
		laneDescription: 'Save triggers HMR, then Preview fetches assets on-demand through esbuild',
		sections: [
			{
				label: 'Save + HMR Path',
				labelColor: 'asset',
				nodes: [
					{ id: 'ap-editor-ui', name: 'Editor UI', detail: 'edit & save', color: 'text' },
					{ id: 'ap-host-worker-1', name: 'Host Worker', detail: 'handleAPI()', color: 'orange' },
					{ id: 'ap-do-filesystem-1', name: 'DO Filesystem', detail: 'Durable Object', color: 'magenta' },
					{ id: 'ap-project-coordinator-1', name: 'ProjectCoordinator', detail: 'triggerUpdate()', color: 'ws' },
					{ id: 'ap-preview-1', name: 'Preview', detail: 'update / reload', color: 'text' },
				],
				edges: [
					{ id: 'ap-e1', source: 'ap-editor-ui', target: 'ap-host-worker-1', label: 'PUT /api/file', color: 'asset' },
					{ id: 'ap-e2', source: 'ap-host-worker-1', target: 'ap-do-filesystem-1', label: 'fs.writeFile()', color: 'magenta' },
					{ id: 'ap-e3', source: 'ap-host-worker-1', target: 'ap-project-coordinator-1', label: 'triggers HMR', color: 'asset' },
					{ id: 'ap-e4', source: 'ap-project-coordinator-1', target: 'ap-preview-1', label: 'HmrUpdateMessage', color: 'ws' },
				],
			},
			{
				label: 'On-Demand Fetch Path',
				labelColor: 'orange',
				nodes: [
					{ id: 'ap-preview-2', name: 'Preview', detail: 'GET /src/main.ts', color: 'text' },
					{ id: 'ap-host-worker-2', name: 'Host Worker', detail: 'serveFile()', color: 'orange' },
					{ id: 'ap-do-filesystem-2', name: 'DO Filesystem', detail: 'read source', color: 'magenta' },
					{ id: 'ap-esbuild-1', name: 'esbuild-wasm', detail: 'TS→JS transform', color: 'yellow' },
					{ id: 'ap-preview-2b', name: 'Preview', detail: 'receives JS', color: 'text' },
				],
				edges: [
					{ id: 'ap-e5', source: 'ap-preview-2', target: 'ap-host-worker-2', label: 'HTTP request', color: 'orange' },
					{ id: 'ap-e6', source: 'ap-host-worker-2', target: 'ap-do-filesystem-2', label: 'fs.readFile()', color: 'magenta' },
					{ id: 'ap-e7', source: 'ap-host-worker-2', target: 'ap-esbuild-1', label: 'transform TS→JS', color: 'yellow' },
					{ id: 'ap-e9', source: 'ap-host-worker-2', target: 'ap-preview-2b', label: '200 OK', color: 'asset' },
				],
			},
		],
		notes: [],
	},

	// 2. Worker Execution
	{
		slug: 'worker-execution',
		title: 'Worker Execution',
		description: 'Preview API requests are bundled from project files and executed inside isolated V8 runtimes.',
		tagline: 'Preview API → bundle worker code → isolate run → response payload',
		accent: 'worker',
		laneDescription: 'API request → read & bundle worker/ → spawn V8 isolate → return response',
		sections: [
			{
				nodes: [
					{ id: 'we-preview', name: 'Preview', detail: "fetch('/api/items')", color: 'text' },
					{ id: 'we-host', name: 'Host Worker', detail: 'handlePreviewAPI()', color: 'orange' },
					{ id: 'we-do-fs', name: 'DO Filesystem', detail: 'read worker/ files', color: 'magenta' },
					{ id: 'we-esbuild', name: 'esbuild-wasm', detail: 'transformCode()', color: 'yellow' },
					{ id: 'we-loader', name: 'Worker Loader', detail: 'dynamic V8 isolate', color: 'worker' },
					{ id: 'we-preview-resp', name: 'Preview', detail: 'receives JSON', color: 'text' },
				],
				edges: [
					{ id: 'we-e1', source: 'we-preview', target: 'we-host', label: '/preview/api/*', color: 'worker' },
					{ id: 'we-e2', source: 'we-host', target: 'we-do-fs', label: 'collectFiles()', color: 'magenta' },
					{ id: 'we-e3', source: 'we-host', target: 'we-esbuild', label: 'bundle input', color: 'yellow' },
					{ id: 'we-e4', source: 'we-esbuild', target: 'we-loader', label: 'runs in isolate', color: 'worker' },
					{ id: 'we-e5', source: 'we-loader', target: 'we-preview-resp', label: '200 OK', color: 'worker' },
				],
			},
		],
		notes: ['Editor UI writes <code>worker/</code> files to DO Filesystem via Host Worker (same as Asset Pipeline save path).'],
	},

	// 3. WebSocket Feedback
	{
		slug: 'websocket-feedback',
		title: 'WebSocket Feedback',
		description: 'Operational events stream through a shared coordinator channel so every collaborator sees the same runtime state.',
		tagline: 'Runtime logs + errors → coordinator normalization → multi-client fan-out',
		accent: 'ws',
		laneDescription: 'Logs & errors flow from Sources → Coordinator → Editor',
		sections: [
			{
				nodes: [
					{ id: 'ws-worker-loader', name: 'Worker Loader', detail: 'console.log()', color: 'worker' },
					{ id: 'ws-log-tailer', name: 'LogTailer', detail: 'tail() handler', color: 'ws' },
					{ id: 'ws-host-worker', name: 'Host Worker', detail: 'catch error', color: 'orange' },
					{ id: 'ws-coordinator', name: 'ProjectCoordinator', detail: 'sendToAll()', color: 'ws' },
					{ id: 'ws-editor-ui', name: 'Editor UI', detail: 'console / overlay', color: 'text' },
				],
				edges: [
					{ id: 'ws-e1', source: 'ws-worker-loader', target: 'ws-log-tailer', label: 'tail binding', color: 'ws' },
					{ id: 'ws-e2', source: 'ws-log-tailer', target: 'ws-coordinator', label: 'ServerLogsMessage', color: 'ws' },
					{ id: 'ws-e3', source: 'ws-host-worker', target: 'ws-coordinator', label: 'ServerErrorMessage', color: 'red' },
					{ id: 'ws-e4', source: 'ws-coordinator', target: 'ws-editor-ui', label: 'WS broadcast', color: 'ws' },
				],
			},
		],
		notes: [],
	},

	// 4. Dependency Resolution
	{
		slug: 'dependency-resolution',
		title: 'Dependency Resolution',
		description: 'Bare imports are resolved against project metadata and rewritten to CDN-backed modules at build time.',
		tagline: 'Import parse → metadata lookup → CDN rewrite → bundled dependency graph',
		accent: 'cyan',
		laneDescription: 'Bare imports resolved via esm.sh CDN at bundle time',
		sections: [
			{
				label: 'Import Resolution Flow',
				labelColor: 'cyan',
				nodes: [
					{ id: 'dr-source', name: 'Source Code', detail: 'import "react"', color: 'text' },
					{ id: 'dr-vfs-plugin', name: 'VirtualFsPlugin', detail: 'bare import check', color: 'yellow' },
					{ id: 'dr-project-meta', name: 'package.json', detail: 'dependencies map', color: 'magenta' },
					{ id: 'dr-esm-cdn-plugin', name: 'EsmCdnPlugin', detail: 'onLoad handler', color: 'cyan' },
					{ id: 'dr-esm-cdn', name: 'esm.sh CDN', detail: 'react@19.0.0', color: 'cyan' },
					{ id: 'dr-esbuild', name: 'esbuild-wasm', detail: 'bundleWithCdn()', color: 'yellow' },
				],
				edges: [
					{ id: 'dr-e1', source: 'dr-source', target: 'dr-vfs-plugin', label: 'onResolve', color: 'yellow' },
					{ id: 'dr-e2', source: 'dr-vfs-plugin', target: 'dr-project-meta', label: 'lookup version', color: 'magenta' },
					{ id: 'dr-e3', source: 'dr-vfs-plugin', target: 'dr-esm-cdn-plugin', label: 'rewrite to CDN URL', color: 'cyan' },
					{ id: 'dr-e4', source: 'dr-esm-cdn-plugin', target: 'dr-esm-cdn', label: 'fetch + cache', color: 'cyan' },
					{ id: 'dr-e5', source: 'dr-esm-cdn', target: 'dr-esbuild', label: 'module payload', color: 'cyan' },
				],
			},
		],
		notes: [
			'Dependencies are managed via <code>package.json</code>. Unregistered imports trigger an error prompting users to add the dependency via the Dependencies panel.',
		],
	},

	// 5. Git Integration
	{
		slug: 'git-integration',
		title: 'Git Integration',
		description: 'Git commands execute inside durable storage context with isomorphic-git and synchronized status updates.',
		tagline: 'Git UI action → Host route → DO mount → isomorphic-git → status broadcast',
		accent: 'emerald',
		laneDescription: 'isomorphic-git running inside Durable Object with SQLite storage',
		sections: [
			{
				label: 'Git Operations Flow',
				labelColor: 'emerald',
				nodes: [
					{ id: 'gi-git-panel', name: 'Git Panel', detail: 'stage / commit', color: 'text' },
					{ id: 'gi-host', name: 'Host Worker', detail: 'git-routes.ts', color: 'orange' },
					{ id: 'gi-expiring-fs', name: 'ExpiringFilesystem', detail: 'Durable Object', color: 'magenta' },
					{ id: 'gi-git-service', name: 'GitService', detail: 'isomorphic-git wrapper', color: 'emerald' },
					{ id: 'gi-iso-git', name: 'isomorphic-git', detail: 'stage / commit / etc', color: 'emerald' },
					{ id: 'gi-worker-fs', name: 'worker-fs-mount', detail: 'DO SQLite storage', color: 'magenta' },
				],
				edges: [
					{ id: 'gi-e1', source: 'gi-git-panel', target: 'gi-host', label: 'POST /api/git/*', color: 'emerald' },
					{ id: 'gi-e2', source: 'gi-host', target: 'gi-expiring-fs', label: 'RPC call', color: 'magenta' },
					{ id: 'gi-e3', source: 'gi-expiring-fs', target: 'gi-git-service', label: 'withMounts()', color: 'emerald' },
					{ id: 'gi-e4', source: 'gi-git-service', target: 'gi-iso-git', label: 'git operations', color: 'emerald' },
					{ id: 'gi-e5', source: 'gi-iso-git', target: 'gi-worker-fs', label: 'node:fs/promises', color: 'magenta' },
				],
			},
			{
				label: 'Real-time Status Updates',
				labelColor: 'ws',
				nodes: [
					{ id: 'gi-expiring-fs-2', name: 'ExpiringFilesystem', detail: 'broadcastGitStatusChanged()', color: 'magenta' },
					{ id: 'gi-coordinator', name: 'ProjectCoordinator', detail: 'sendMessage()', color: 'ws' },
					{ id: 'gi-git-panel-2', name: 'Git Panel', detail: 'refetch status', color: 'text' },
				],
				edges: [
					{ id: 'gi-e6', source: 'gi-expiring-fs-2', target: 'gi-coordinator', label: 'RPC', color: 'ws' },
					{ id: 'gi-e7', source: 'gi-coordinator', target: 'gi-git-panel-2', label: 'git-status-changed', color: 'ws' },
				],
			},
		],
		notes: [
			"Git operations run inside the Durable Object's single-threaded context, avoiding race conditions with isomorphic-git's AsyncLock. The <code>node:fs/promises</code> import is aliased to <code>worker-fs-mount/fs</code> at build time.",
		],
	},

	// 6. AI Agent System
	{
		slug: 'ai-agent',
		title: 'AI Agent System',
		description: 'AgentRunner Durable Objects execute autonomous coding runs with tool calls and resumable stream state.',
		tagline: 'Chat request → guarded dispatch → tool/model loop → streamed project updates',
		accent: 'ai',
		laneDescription: 'Autonomous coding agent with 24 tools, running in a dedicated Durable Object',
		sections: [
			{
				label: 'Agent Loop',
				labelColor: 'ai',
				nodes: [
					{ id: 'ai-editor', name: 'Editor UI', detail: 'chat message', color: 'text' },
					{ id: 'ai-host', name: 'Host Worker', detail: 'rate limit + validate', color: 'orange' },
					{ id: 'ai-agent-runner', name: 'AgentRunner DO', detail: 'per-project Durable Object', color: 'ai' },
					{ id: 'ai-service', name: 'AIAgentService', detail: '24 tools, 3 modes', color: 'ai' },
					{ id: 'ai-workers-ai', name: 'Workers AI', detail: 'streamText() with retry', color: 'yellow' },
					{ id: 'ai-expiring-fs', name: 'ExpiringFilesystem', detail: 'file read / write', color: 'magenta' },
				],
				edges: [
					{ id: 'ai-e1', source: 'ai-editor', target: 'ai-host', label: 'POST /api/ai/chat', color: 'ai' },
					{ id: 'ai-e2', source: 'ai-host', target: 'ai-agent-runner', label: 'RPC', color: 'ai' },
					{ id: 'ai-e3', source: 'ai-agent-runner', target: 'ai-service', label: 'ctx.waitUntil()', color: 'ai' },
					{ id: 'ai-e4', source: 'ai-service', target: 'ai-workers-ai', label: 'LLM call', color: 'yellow' },
					{ id: 'ai-e5', source: 'ai-service', target: 'ai-expiring-fs', label: 'tool execution', color: 'magenta' },
				],
			},
			{
				label: 'Agent SDK State Sync',
				labelColor: 'ws',
				nodes: [
					{ id: 'ai-agent-runner-2', name: 'AgentRunner DO', detail: 'buffer + index chunks', color: 'ai' },
					{ id: 'ai-coordinator', name: 'ProjectCoordinator', detail: 'WS fan-out', color: 'ws' },
					{ id: 'ai-editor-2', name: 'Editor UI', detail: 'useAgent + Agents SDK', color: 'text' },
				],
				edges: [
					{ id: 'ai-e6', source: 'ai-agent-runner-2', target: 'ai-coordinator', label: 'sendMessage()', color: 'ws' },
					{ id: 'ai-e7', source: 'ai-coordinator', target: 'ai-editor-2', label: 'agent-stream-event', color: 'ws' },
				],
			},
		],
		notes: [
			'The agent runs <strong>independently of client connections</strong> inside the AgentRunner DO. In-flight runs recover from persisted fiber checkpoints after eviction, rather than relying on a custom heartbeat loop. Three modes: <code>code</code> (full tool access), <code>plan</code> (read-only + planning), <code>ask</code> (read-only Q&amp;A). Tools include file CRUD, grep/glob, lint check/fix (via Biome service binding), test execution, browser automation via the Agents SDK browser tools, web fetch, and Cloudflare docs search via MCP.',
		],
	},

	// 7. Test Runner
	{
		slug: 'test-runner',
		title: 'Test Runner',
		description: 'A built-in test harness runs in isolated runtimes and publishes structured result updates in real time.',
		tagline: 'Run request → bundle harness + tests → isolate execution → synchronized results',
		accent: 'test',
		laneDescription: 'In-browser test execution with a built-in describe/it/expect harness',
		sections: [
			{
				label: 'Test Execution',
				labelColor: 'test',
				nodes: [
					{ id: 'tr-tests-panel', name: 'Tests Panel', detail: 'run all / file / test', color: 'text' },
					{ id: 'tr-host', name: 'Host Worker', detail: 'discover + collect', color: 'orange' },
					{ id: 'tr-esbuild', name: 'esbuild-wasm', detail: 'harness + test file', color: 'yellow' },
					{ id: 'tr-loader', name: 'WorkerLoader', detail: 'sandboxed V8 isolate', color: 'worker' },
					{ id: 'tr-tests-panel-resp', name: 'Tests Panel', detail: 'receives JSON results', color: 'test' },
				],
				edges: [
					{ id: 'tr-e1', source: 'tr-tests-panel', target: 'tr-host', label: 'POST /api/test/run', color: 'test' },
					{ id: 'tr-e2', source: 'tr-host', target: 'tr-esbuild', label: 'bundleWithCdn()', color: 'yellow' },
					{ id: 'tr-e3', source: 'tr-esbuild', target: 'tr-loader', label: 'runs in isolate', color: 'worker' },
					{ id: 'tr-e4', source: 'tr-loader', target: 'tr-tests-panel-resp', label: 'TestRunResponse', color: 'test' },
				],
			},
			{
				label: 'Result Broadcasting',
				labelColor: 'ws',
				nodes: [
					{ id: 'tr-host-2', name: 'Host Worker', detail: 'sendMessage()', color: 'orange' },
					{ id: 'tr-coordinator', name: 'ProjectCoordinator', detail: 'WS broadcast', color: 'ws' },
					{ id: 'tr-tests-panel-2', name: 'Tests Panel', detail: 'merge into cache', color: 'text' },
				],
				edges: [
					{ id: 'tr-e5', source: 'tr-host-2', target: 'tr-coordinator', label: 'RPC', color: 'ws' },
					{ id: 'tr-e6', source: 'tr-coordinator', target: 'tr-tests-panel-2', label: 'test-results-changed', color: 'ws' },
				],
			},
		],
		notes: [
			"Tests use a built-in <code>describe</code>/<code>it</code>/<code>expect</code> harness — no Vitest or Jest dependency. Each test file is bundled with the harness and executed in an isolated WorkerLoader V8 sandbox (max 30s timeout). The AI agent's <code>test_run</code> tool shares the same runner. Partial re-runs merge results at the suite level via <code>mergeTestRunResults()</code>.",
		],
	},

	// 8. Deploy Pipeline
	{
		slug: 'deploy-pipeline',
		title: 'Deploy Pipeline',
		description: 'Deployment packages assets and worker code, uploads them, then returns a production URL.',
		tagline: 'Deploy trigger → file collection → bundle + upload → script publish',
		accent: 'deploy',
		laneDescription: 'One-click production deployment to the edge',
		sections: [
			{
				label: 'Deploy Flow',
				labelColor: 'deploy',
				nodes: [
					{ id: 'dp-deploy-modal', name: 'Deploy Modal', detail: 'credentials + deploy', color: 'text' },
					{ id: 'dp-host', name: 'Host Worker', detail: 'collectProjectFiles()', color: 'orange' },
					{ id: 'dp-do-fs', name: 'DO Filesystem', detail: 'worker/ + src/ files', color: 'magenta' },
					{ id: 'dp-esbuild', name: 'esbuild-wasm', detail: 'worker + frontend bundles', color: 'yellow' },
					{ id: 'dp-cf-api', name: 'Cloudflare API', detail: 'Direct Upload + Script PUT', color: 'deploy' },
					{ id: 'dp-deploy-modal-resp', name: 'Deploy Modal', detail: 'receives worker URL', color: 'text' },
				],
				edges: [
					{ id: 'dp-e1', source: 'dp-deploy-modal', target: 'dp-host', label: 'POST /api/deploy', color: 'deploy' },
					{ id: 'dp-e2', source: 'dp-host', target: 'dp-do-fs', label: 'read all files', color: 'magenta' },
					{ id: 'dp-e3', source: 'dp-host', target: 'dp-esbuild', label: 'esbuild bundle', color: 'yellow' },
					{ id: 'dp-e4', source: 'dp-esbuild', target: 'dp-cf-api', label: 'upload to Cloudflare', color: 'deploy' },
					{ id: 'dp-e5', source: 'dp-cf-api', target: 'dp-deploy-modal-resp', label: 'workerUrl', color: 'deploy' },
				],
			},
		],
		notes: [
			'Static assets are uploaded via the Direct Upload API (content-hashed manifest + batched uploads), then the bundled worker script is deployed with a completion JWT linking assets to the script. Asset settings (<code>not_found_handling</code>, <code>html_handling</code>, <code>run_worker_first</code>) from the project configuration are included in the deploy metadata. Credentials are stored client-side in localStorage.',
		],
	},

	// 9. Snapshots + Revert
	{
		slug: 'snapshots',
		title: 'Snapshots + Revert',
		description: 'Before AI mutations, file snapshots are stored so users can revert individual files or full runs.',
		tagline: 'Pre-mutation capture → durable snapshot → revert command → reload broadcast',
		accent: 'snapshot',
		laneDescription: 'Point-in-time backups of files before AI agent modifications',
		sections: [
			{
				label: 'Snapshot Creation (during AI runs)',
				labelColor: 'snapshot',
				nodes: [
					{ id: 'sn-ai-service', name: 'AIAgentService', detail: 'code mode run', color: 'ai' },
					{ id: 'sn-snapshot-fn', name: 'addFileToSnapshot()', detail: 'saves before-content', color: 'snapshot' },
					{ id: 'sn-snapshot-dir', name: '.agent/snapshots/', detail: 'metadata.json + files', color: 'magenta' },
				],
				edges: [
					{ id: 'sn-e1', source: 'sn-ai-service', target: 'sn-snapshot-fn', label: 'file mutation', color: 'snapshot' },
					{ id: 'sn-e2', source: 'sn-snapshot-fn', target: 'sn-snapshot-dir', label: 'fs.writeFile()', color: 'magenta' },
				],
			},
			{
				label: 'Revert Flow',
				labelColor: 'snapshot',
				nodes: [
					{ id: 'sn-editor', name: 'Editor UI', detail: 'revert snapshot', color: 'text' },
					{ id: 'sn-host', name: 'Host Worker', detail: 'restore files', color: 'orange' },
					{ id: 'sn-do-fs', name: 'DO Filesystem', detail: 'overwrites with backup', color: 'magenta' },
				],
				edges: [
					{ id: 'sn-e3', source: 'sn-editor', target: 'sn-host', label: 'POST /api/snapshot/revert', color: 'snapshot' },
					{ id: 'sn-e4', source: 'sn-host', target: 'sn-do-fs', label: 'fs.writeFile()', color: 'magenta' },
				],
			},
		],
		notes: [
			'Snapshots are created automatically at the start of each AI <code>code</code> mode run. The before-content of every mutated file is saved to <code>.agent/snapshots/&lt;id&gt;/</code>. Supports single-file revert, full-snapshot revert, and cascade revert (multiple snapshots in reverse-chronological order with per-file deduplication). Rolling limit of 10 snapshots. Reverts trigger HMR <code>full-reload</code> via the ProjectCoordinator.',
		],
	},

	// 10. Real-time Collaboration
	{
		slug: 'collaboration',
		title: 'Real-time Collaboration',
		description: 'All participants share one project socket channel for cursors, edits, and operational events.',
		tagline: 'Participant events → project coordinator → peer updates',
		accent: 'collab',
		laneDescription: 'Multi-user editing with cursor sharing and file edit broadcasting',
		sections: [
			{
				nodes: [
					{ id: 'co-editor-a', name: 'Editor A', detail: 'cursor-update', color: 'collab' },
					{ id: 'co-editor-b', name: 'Editor B', detail: 'file-edit', color: 'collab' },
					{ id: 'co-coordinator', name: 'ProjectCoordinator', detail: 'hibernating WS hub', color: 'ws' },
					{ id: 'co-all-editors', name: 'All Editors', detail: 'synchronized state', color: 'text' },
				],
				edges: [
					{
						id: 'co-e1',
						source: 'co-editor-a',
						target: 'co-coordinator',
						label: 'cursor position + selection',
						color: 'collab',
					},
					{ id: 'co-e2', source: 'co-editor-b', target: 'co-coordinator', label: 'path + content', color: 'asset' },
					{ id: 'co-e3', source: 'co-coordinator', target: 'co-all-editors', label: 'broadcast to all', color: 'ws' },
				],
			},
		],
		notes: [
			'All real-time features share a single WebSocket connection per client through the ProjectCoordinator DO (keyed <code>project:&lt;id&gt;</code>). Uses the WebSocket Hibernation API — connections survive DO eviction. On <code>collab-join</code>, the server sends back <code>collab-state</code> with participant list, self-id, assigned color, and any running AI sessions. The full protocol has 7 client message types and 15 server message types covering HMR, collaboration, errors/logs, AI streaming, git status, and test results.',
		],
	},
];

export function getTopicBySlug(slug: string): DocsTopic | undefined {
	return docsTopics.find((topic) => topic.slug === slug);
}
