import { DurableObjectFilesystem } from 'durable-object-fs';
import { mount, withMounts } from 'worker-fs-mount';
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
import fs from 'node:fs/promises';
import Replicate from 'replicate';
import { transformCode } from './bundler.js';
import { transformModule, processHTML, type FileSystem } from './transform.js';
import examplePackageJson from './example-project/package.json?raw';
import exampleTsconfig from './example-project/tsconfig.json?raw';
import exampleIndexHtml from './example-project/index.html?raw';
import exampleMainTs from './example-project/src/main.ts?raw';
import exampleApiTs from './example-project/src/api.ts?raw';
import exampleStyleCss from './example-project/src/style.css?raw';
import exampleWorkerDbTs from './example-project/worker/db.ts?raw';
import exampleWorkerHandlersTs from './example-project/worker/handlers.ts?raw';
import exampleWorkerIndexTs from './example-project/worker/index.ts?raw';
import docsHtml from '../docs/index.html?raw';

export { DurableObjectFilesystem };


// AI Agent Types
interface AgentMessage {
	role: 'user' | 'assistant';
	content: any;
}

interface AgentTool {
	name: string;
	description: string;
	input_schema: {
		type: 'object';
		properties: Record<string, { type: string; description: string }>;
		required?: string[];
	};
}

interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, string>;
}

interface TextBlock {
	type: 'text';
	text: string;
}

type ContentBlock = TextBlock | ToolUseBlock;

interface ClaudeResponse {
	id: string;
	type: string;
	role: string;
	content: ContentBlock[];
	stop_reason: string | null;
	stop_sequence: string | null;
}

// Agent tool definitions
const AGENT_TOOLS: AgentTool[] = [
	{
		name: 'list_files',
		description: 'List all files in the project. Returns an array of file paths.',
		input_schema: {
			type: 'object',
			properties: {},
		},
	},
	{
		name: 'read_file',
		description: 'Read the contents of a file. Use this to understand existing code before making changes.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path starting with /, e.g., /src/main.ts' },
			},
			required: ['path'],
		},
	},
	{
		name: 'write_file',
		description: 'Create a new file or overwrite an existing file with new content.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path starting with /, e.g., /src/utils.ts' },
				content: { type: 'string', description: 'The complete file content to write' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'delete_file',
		description: 'Delete a file from the project.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path to delete, starting with /' },
			},
			required: ['path'],
		},
	},
	{
		name: 'move_file',
		description: 'Move or rename a file.',
		input_schema: {
			type: 'object',
			properties: {
				from_path: { type: 'string', description: 'Current file path' },
				to_path: { type: 'string', description: 'New file path' },
			},
			required: ['from_path', 'to_path'],
		},
	},
];

const AGENT_SYSTEM_PROMPT = `You are an AI coding assistant integrated into a web-based IDE. Your role is to help users modify their codebase by reading, creating, editing, and deleting files.

IMPORTANT GUIDELINES:
1. Always read relevant files first before making changes to understand the existing code structure
2. When modifying files, preserve existing code style and patterns
3. Explain what you're doing and why before making changes
4. Make targeted, minimal changes - don't rewrite entire files unless necessary
5. After making changes, summarize what was modified

You have access to a virtual filesystem with the following tools:
- list_files: See all files in the project
- read_file: Read a file's contents
- write_file: Create or update a file
- delete_file: Remove a file
- move_file: Rename or move a file

The project is a TypeScript/JavaScript web application with:
- /src/ - Frontend source code
- /worker/ - Cloudflare Worker backend code
- /index.html - Main HTML entry point
- /package.json - Project dependencies

Be concise but helpful. Focus on making the requested changes efficiently.`;

interface LogEntry {
	type: string;
	timestamp: number;
	level: string;
	message: string;
}

export class LogTailer extends WorkerEntrypoint<Env> {
	private async broadcastLogs(entries: LogEntry[]) {
		if (entries.length === 0) return;
		const projectId = (this.ctx.props as { projectId: string }).projectId;
		const hmrId = this.env.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
		const hmrStub = this.env.DO_HMR_COORDINATOR.get(hmrId);
		await hmrStub.fetch(new Request('http://internal/hmr/send', {
			method: 'POST',
			body: JSON.stringify({ type: 'server-logs', logs: entries }),
		}));
	}

	async tail(events: TraceItem[]) {
		for (const event of events) {
			const entries: LogEntry[] = [];
			for (const log of event.logs) {
				entries.push({
					type: 'server-log',
					timestamp: log.timestamp,
					level: log.level,
					message: (log.message as unknown[]).map((m: unknown) => typeof m === 'string' ? m : JSON.stringify(m)).join(' '),
				});
			}
			await this.broadcastLogs(entries);
		}
	}
}

// Server error type for the UI terminal
interface ServerError {
	timestamp: number;
	type: 'bundle' | 'runtime';
	message: string;
	file?: string;
	line?: number;
	column?: number;
}

interface HMRUpdate {
	type: 'update' | 'full-reload';
	path: string;
	timestamp: number;
	isCSS?: boolean;
}

const COLLAB_COLORS = [
	'#f97316', '#22d3ee', '#a78bfa', '#f472b6',
	'#4ade80', '#facc15', '#fb923c', '#38bdf8',
	'#c084fc', '#f87171', '#34d399', '#e879f9',
];

interface ParticipantAttachment {
	id: string;
	color: string;
	file: string | null;
	cursor: { line: number; ch: number } | null;
	selection: { anchor: { line: number; ch: number }; head: { line: number; ch: number } } | null;
}

export class HMRCoordinator extends DurableObject {
	private colorIndex = 0;

	private getAttachment(ws: WebSocket): ParticipantAttachment | null {
		try {
			return ws.deserializeAttachment() as ParticipantAttachment;
		} catch {
			return null;
		}
	}

	private setAttachment(ws: WebSocket, data: ParticipantAttachment) {
		ws.serializeAttachment(data);
	}

	private nextColor(): string {
		const color = COLLAB_COLORS[this.colorIndex % COLLAB_COLORS.length];
		this.colorIndex++;
		return color;
	}

	private getAllParticipants(): ParticipantAttachment[] {
		const participants: ParticipantAttachment[] = [];
		for (const ws of this.ctx.getWebSockets()) {
			const att = this.getAttachment(ws);
			if (att) participants.push(att);
		}
		return participants;
	}

	private sendToOthers(sender: WebSocket, message: string) {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === sender) continue;
			try { ws.send(message); } catch { try { ws.close(1011, 'send failed'); } catch {} }
		}
	}

	private sendToAll(message: string) {
		for (const ws of this.ctx.getWebSockets()) {
			try { ws.send(message); } catch { try { ws.close(1011, 'send failed'); } catch {} }
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/hmr' && request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			const participantId = crypto.randomUUID();
			const color = this.nextColor();
			const attachment: ParticipantAttachment = {
				id: participantId,
				color,
				file: null,
				cursor: null,
				selection: null,
			};

			this.ctx.acceptWebSocket(server);
			this.setAttachment(server, attachment);

			return new Response(null, { status: 101, webSocket: client });
		}

		if (url.pathname === '/hmr/trigger' && request.method === 'POST') {
			const update = (await request.json()) as HMRUpdate;
			await this.broadcast(update);
			return new Response(JSON.stringify({ success: true }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.pathname === '/hmr/send' && request.method === 'POST') {
			const message = await request.text();
			this.sendToAll(message);
			return new Response(JSON.stringify({ success: true }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		return new Response('Not found', { status: 404 });
	}

	async broadcast(update: HMRUpdate) {
		let updateType: string;
		if (update.type === 'full-reload') {
			updateType = 'full-reload';
		} else if (update.isCSS) {
			updateType = 'css-update';
		} else {
			updateType = 'js-update';
		}

		const message = JSON.stringify({
			type: update.type,
			updates: [
				{
					type: updateType,
					path: update.path,
					timestamp: update.timestamp,
				},
			],
		});

		this.sendToAll(message);
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			const messageStr = typeof message === 'string' ? message : new TextDecoder().decode(message);
			const data = JSON.parse(messageStr);

			if (data.type === 'ping') {
				ws.send(JSON.stringify({ type: 'pong' }));
				return;
			}

			if (data.type === 'collab-join') {
				const att = this.getAttachment(ws);
				if (!att) return;
				ws.send(JSON.stringify({
					type: 'collab-state',
					selfId: att.id,
					selfColor: att.color,
					participants: this.getAllParticipants(),
				}));
				this.sendToOthers(ws, JSON.stringify({
					type: 'participant-joined',
					participant: att,
				}));
				return;
			}

			if (data.type === 'cursor-update') {
				const att = this.getAttachment(ws);
				if (!att) return;
				att.file = data.file ?? null;
				att.cursor = data.cursor ?? null;
				att.selection = data.selection ?? null;
				this.setAttachment(ws, att);
				this.sendToOthers(ws, JSON.stringify({
					type: 'cursor-updated',
					id: att.id,
					color: att.color,
					file: att.file,
					cursor: att.cursor,
					selection: att.selection,
				}));
				return;
			}

			if (data.type === 'file-edit') {
				const att = this.getAttachment(ws);
				if (!att) return;
				this.sendToOthers(ws, JSON.stringify({
					type: 'file-edited',
					id: att.id,
					path: data.path,
					content: data.content,
				}));
				return;
			}
		} catch {}
	}

	webSocketClose(ws: WebSocket) {
		const att = this.getAttachment(ws);
		if (att) {
			this.sendToOthers(ws, JSON.stringify({
				type: 'participant-left',
				id: att.id,
			}));
		}
	}

	webSocketError(ws: WebSocket) {
		const att = this.getAttachment(ws);
		if (att) {
			this.sendToOthers(ws, JSON.stringify({
				type: 'participant-left',
				id: att.id,
			}));
		}
		try { ws.close(1011, 'WebSocket error'); } catch {}
	}
}

const EXAMPLE_PROJECT: Record<string, string> = {
	'package.json': examplePackageJson,
	'tsconfig.json': exampleTsconfig,
	'index.html': exampleIndexHtml,
	'src/main.ts': exampleMainTs,
	'src/api.ts': exampleApiTs,
	'src/style.css': exampleStyleCss,
	'worker/db.ts': exampleWorkerDbTs,
	'worker/handlers.ts': exampleWorkerHandlersTs,
	'worker/index.ts': exampleWorkerIndexTs,
};

async function ensureExampleProject(projectRoot: string) {
	const sentinelPath = `${projectRoot}/.initialized`;
	try {
		await fs.readFile(sentinelPath);
		return;
	} catch {
		// not yet initialized
	}
	for (const [filePath, content] of Object.entries(EXAMPLE_PROJECT)) {
		const fullPath = `${projectRoot}/${filePath}`;
		try {
			await fs.readFile(fullPath);
		} catch {
			const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(fullPath, content);
		}
	}
	await fs.writeFile(sentinelPath, '1');
}

function isPathSafe(basePath: string, requestedPath: string): boolean {
	if (!requestedPath.startsWith('/')) {
		return false;
	}
	if (requestedPath.includes('..')) {
		return false;
	}
	const normalizedPath = requestedPath.replace(/\/+/g, '/');
	if (requestedPath !== normalizedPath) {
		return false;
	}
	return true;
}

function getContentType(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase();
	const types: Record<string, string> = {
		html: 'text/html',
		js: 'application/javascript',
		mjs: 'application/javascript',
		css: 'text/css',
		json: 'application/json',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		webp: 'image/webp',
		svg: 'image/svg+xml',
		ico: 'image/x-icon',
		woff: 'font/woff',
		woff2: 'font/woff2',
		ttf: 'font/ttf',
		eot: 'application/vnd.ms-fontobject',
		mp3: 'audio/mpeg',
		wav: 'audio/wav',
		mp4: 'video/mp4',
		webm: 'video/webm',
		txt: 'text/plain',
		md: 'text/markdown',
	};
	return types[ext || ''] || 'application/octet-stream';
}

interface TransformResult {
	body: string | Uint8Array;
	contentType: string;
}

const TRANSFORM_TO_JS_MODULE = new Set(['.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.txt', '.md']);
const COMPILE_TO_JS = new Set(['.ts', '.tsx', '.jsx', '.mts']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.wav', '.mp4', '.webm']);

function getExtension(path: string): string {
	const match = path.match(/\.[^.]+$/);
	return match ? match[0].toLowerCase() : '';
}

function transformToJsModule(content: string | Uint8Array, filePath: string, contentType: string): TransformResult {
	const ext = getExtension(filePath);

	if (ext === '.css') {
		const cssContent = JSON.stringify(typeof content === 'string' ? content : new TextDecoder().decode(content));
		return {
			body: `const css = ${cssContent};
const style = document.createElement('style');
style.setAttribute('data-dev-id', ${JSON.stringify(filePath)});
style.textContent = css;
document.head.appendChild(style);
export default css;`,
			contentType: 'application/javascript',
		};
	}

	if (ext === '.json') {
		const jsonContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
		return {
			body: `export default ${jsonContent};`,
			contentType: 'application/javascript',
		};
	}

	if (ext === '.svg') {
		const svgContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
		const dataUrl = `data:image/svg+xml,${encodeURIComponent(svgContent)}`;
		return {
			body: `export default ${JSON.stringify(dataUrl)};`,
			contentType: 'application/javascript',
		};
	}

	if (BINARY_EXTENSIONS.has(ext)) {
		const binary = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
		let base64 = '';
		const chunkSize = 8192;
		for (let i = 0; i < binary.length; i += chunkSize) {
			const chunk = binary.subarray(i, i + chunkSize);
			base64 += String.fromCharCode(...chunk);
		}
		base64 = btoa(base64);
		const dataUrl = `data:${contentType};base64,${base64}`;
		return {
			body: `export default ${JSON.stringify(dataUrl)};`,
			contentType: 'application/javascript',
		};
	}

	if (ext === '.txt' || ext === '.md') {
		const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
		return {
			body: `export default ${JSON.stringify(textContent)};`,
			contentType: 'application/javascript',
		};
	}

	return { body: content, contentType };
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
		table[i] = c;
	}
	return table;
})();

function crc32(data: Uint8Array): number {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createZip(files: Record<string, string | Uint8Array>): Uint8Array {
	const encoder = new TextEncoder();
	const entries: { name: Uint8Array; data: Uint8Array; crc: number; offset: number }[] = [];
	const parts: Uint8Array[] = [];
	let offset = 0;

	for (const [name, content] of Object.entries(files)) {
		const nameBytes = encoder.encode(name);
		const dataBytes = typeof content === 'string' ? encoder.encode(content) : content;
		const fileCrc = crc32(dataBytes);

		const header = new Uint8Array(30 + nameBytes.length);
		const hv = new DataView(header.buffer);
		hv.setUint32(0, 0x04034b50, true);
		hv.setUint16(4, 20, true);
		hv.setUint32(14, fileCrc, true);
		hv.setUint32(18, dataBytes.length, true);
		hv.setUint32(22, dataBytes.length, true);
		hv.setUint16(26, nameBytes.length, true);
		header.set(nameBytes, 30);

		entries.push({ name: nameBytes, data: dataBytes, crc: fileCrc, offset });
		parts.push(header, dataBytes);
		offset += header.length + dataBytes.length;
	}

	const cdStart = offset;
	for (const entry of entries) {
		const cd = new Uint8Array(46 + entry.name.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint32(16, entry.crc, true);
		cv.setUint32(20, entry.data.length, true);
		cv.setUint32(24, entry.data.length, true);
		cv.setUint16(28, entry.name.length, true);
		cv.setUint32(42, entry.offset, true);
		cd.set(entry.name, 46);
		parts.push(cd);
		offset += cd.length;
	}

	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, offset - cdStart, true);
	ev.setUint32(16, cdStart, true);
	parts.push(eocd);

	const total = parts.reduce((s, p) => s + p.length, 0);
	const result = new Uint8Array(total);
	let pos = 0;
	for (const part of parts) { result.set(part, pos); pos += part.length; }
	return result;
}

function parseProjectRoute(path: string): { projectId: string; subPath: string } | null {
	const match = path.match(/^\/p\/([a-f0-9]{64})(\/.*)$/i);
	if (match) {
		return { projectId: match[1].toLowerCase(), subPath: match[2] };
	}
	const exactMatch = path.match(/^\/p\/([a-f0-9]{64})$/i);
	if (exactMatch) {
		return { projectId: exactMatch[1].toLowerCase(), subPath: '/' };
	}
	return null;
}

export default class extends WorkerEntrypoint<Env> {
	private projectRoot = '/project';
	private lastBroadcastWasErrorMap = new Map<string, boolean>();
	private initializedProjectsCache = new Set<string>();

	private setLastBroadcastWasError(projectId: string, value: boolean) {
		this.lastBroadcastWasErrorMap.set(projectId, value);
	}

	private async broadcastMessage(projectId: string, message: object) {
		const hmrId = this.env.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
		const hmrStub = this.env.DO_HMR_COORDINATOR.get(hmrId);
		await hmrStub.fetch(new Request('http://internal/hmr/send', {
			method: 'POST',
			body: JSON.stringify(message),
		}));
	}

	async fetch(request: Request) {
		const url = new URL(request.url);
		const path = url.pathname;

		// Serve documentation
		if (path === '/about' || path === '/about/') {
			return new Response(docsHtml, {
				headers: { 'Content-Type': 'text/html' },
			});
		}

		// API to create a new project
		if (path === '/api/new-project' && request.method === 'POST') {
			const id = this.env.DO_FILESYSTEM.newUniqueId();
			const projectId = id.toString();
			return Response.json({ projectId, url: `/p/${projectId}` });
		}

		// Handle project-scoped routes: /p/:projectId/*
		const projectRoute = parseProjectRoute(path);
		if (projectRoute) {
			return this.handleProjectRequest(request, projectRoute.projectId, projectRoute.subPath);
		}

		// All other routes serve the IDE HTML (SPA handles redirect to /p/:projectId)
		return this.env.ASSETS.fetch(request);
	}

	private async handleProjectRequest(request: Request, projectId: string, subPath: string): Promise<Response> {
		return withMounts(async () => {
			const fsId = this.env.DO_FILESYSTEM.idFromString(projectId);
			const fsStub = this.env.DO_FILESYSTEM.get(fsId);
			mount('/project', fsStub);

			if (!this.initializedProjectsCache.has(projectId)) {
				await ensureExampleProject(this.projectRoot);
				this.initializedProjectsCache.add(projectId);
			}

			const basePrefix = `/p/${projectId}`;

			// WebSocket HMR endpoint
			if (subPath === '/__hmr' || subPath.startsWith('/__hmr')) {
				const hmrId = this.env.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
				const hmrStub = this.env.DO_HMR_COORDINATOR.get(hmrId);
				const hmrUrl = new URL(request.url);
				hmrUrl.pathname = '/hmr';
				return hmrStub.fetch(new Request(hmrUrl, request));
			}

			// API endpoints for file modification
			if (subPath.startsWith('/api/')) {
				return this.handleAPI(request, projectId, basePrefix);
			}

			// Handle preview API routes (example project's backend)
			if (subPath.startsWith('/preview/api/')) {
				return this.handlePreviewAPI(request, subPath.replace('/preview', ''), projectId);
			}

			// Serve project files under /preview path
			if (subPath === '/preview' || subPath.startsWith('/preview/')) {
				const previewPath = subPath === '/preview' ? '/' : subPath.replace(/^\/preview/, '');
				const previewUrl = new URL(request.url);
				previewUrl.pathname = previewPath;
				return this.serveFile(new Request(previewUrl, request), { baseHref: `${basePrefix}/preview/`, projectId });
			}

			// Serve the IDE HTML for the project root and any unknown sub-paths
			return this.env.ASSETS.fetch(new Request(new URL('/', request.url), request));
		});
	}

	private async handleAPI(request: Request, projectId: string, basePrefix?: string): Promise<Response> {
		const url = new URL(request.url);
		// Strip basePrefix from path for matching
		const fullPath = url.pathname;
		const path = basePrefix && fullPath.startsWith(basePrefix) ? fullPath.slice(basePrefix.length) : fullPath;

		const headers = {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers });
		}

		try {
			// GET /api/files - list all files
			if (path === '/api/files' && request.method === 'GET') {
				const files = await this.listFilesRecursive(this.projectRoot);
				return new Response(JSON.stringify({ files }), { headers });
			}

			// GET /api/file?path=/src/main.js - read file
			if (path === '/api/file' && request.method === 'GET') {
				const filePath = url.searchParams.get('path');
				if (!filePath) {
					return new Response(JSON.stringify({ error: 'path required' }), {
						status: 400,
						headers,
					});
				}
				if (!isPathSafe(this.projectRoot, filePath)) {
					return new Response(JSON.stringify({ error: 'invalid path' }), {
						status: 400,
						headers,
					});
				}
				const content = await fs.readFile(`${this.projectRoot}${filePath}`, 'utf8');
				return new Response(JSON.stringify({ path: filePath, content }), { headers });
			}

			// PUT /api/file - write file and trigger HMR
			if (path === '/api/file' && request.method === 'PUT') {
				const body = (await request.json()) as { path: string; content: string };
				if (!isPathSafe(this.projectRoot, body.path)) {
					return new Response(JSON.stringify({ error: 'invalid path' }), {
						status: 400,
						headers,
					});
				}
				await fs.writeFile(`${this.projectRoot}${body.path}`, body.content);

				// Trigger HMR update
				const hmrId = this.env.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
				const hmrStub = this.env.DO_HMR_COORDINATOR.get(hmrId);
				const isCSS = body.path.endsWith('.css');
				await hmrStub.fetch(
					new Request('http://internal/hmr/trigger', {
						method: 'POST',
						body: JSON.stringify({
							type: isCSS ? 'update' : 'full-reload',
							path: body.path,
							timestamp: Date.now(),
							isCSS,
						}),
					})
				);

				return new Response(JSON.stringify({ success: true, path: body.path }), { headers });
			}

			// DELETE /api/file?path=/src/old.js - delete file
			if (path === '/api/file' && request.method === 'DELETE') {
				const filePath = url.searchParams.get('path');
				if (!filePath) {
					return new Response(JSON.stringify({ error: 'path required' }), {
						status: 400,
						headers,
					});
				}
				if (!isPathSafe(this.projectRoot, filePath)) {
					return new Response(JSON.stringify({ error: 'invalid path' }), {
						status: 400,
						headers,
					});
				}
				await fs.unlink(`${this.projectRoot}${filePath}`);
				return new Response(JSON.stringify({ success: true }), { headers });
			}

			// POST /api/mkdir - create directory
			if (path === '/api/mkdir' && request.method === 'POST') {
				const body = (await request.json()) as { path: string };
				if (!isPathSafe(this.projectRoot, body.path)) {
					return new Response(JSON.stringify({ error: 'invalid path' }), {
						status: 400,
						headers,
					});
				}
				await fs.mkdir(`${this.projectRoot}${body.path}`, { recursive: true });
				return new Response(JSON.stringify({ success: true }), { headers });
			}

			// POST /api/transform - transform a single file with esbuild
			if (path === '/api/transform' && request.method === 'POST') {
				const body = (await request.json()) as { code: string; filename: string };
				const result = await transformCode(body.code, body.filename, { sourcemap: true });
				return new Response(JSON.stringify({
					success: true,
					code: result.code,
					map: result.map
				}), { headers });
			}

			// GET /api/download - download project as deployable zip
			if (path === '/api/download' && request.method === 'GET') {
				const projectFiles = await this.collectFilesForBundle(this.projectRoot);
				delete projectFiles['.initialized'];

				let pkgJson: Record<string, unknown> = {};
				let projectName = 'my-worker-app';
				if (projectFiles['package.json']) {
					try {
						pkgJson = JSON.parse(projectFiles['package.json']);
						if (typeof pkgJson.name === 'string') projectName = pkgJson.name;
					} catch {}
				}

				pkgJson.scripts = {
					...(pkgJson.scripts as Record<string, string> || {}),
					dev: 'vite dev',
					build: 'vite build',
					deploy: 'vite build && wrangler deploy',
				};
				pkgJson.devDependencies = {
					...(pkgJson.devDependencies as Record<string, string> || {}),
					'@cloudflare/vite-plugin': '^1.0.0',
					vite: '^6.0.0',
					wrangler: '^4.0.0',
				};

				const prefix = `${projectName}/`;
				const zipFiles: Record<string, string> = {};

				for (const [filePath, content] of Object.entries(projectFiles)) {
					if (filePath === 'package.json') continue;
					zipFiles[`${prefix}${filePath}`] = content;
				}

				zipFiles[`${prefix}package.json`] = JSON.stringify(pkgJson, null, 2);

				zipFiles[`${prefix}wrangler.jsonc`] = JSON.stringify({
					$schema: 'node_modules/wrangler/config-schema.json',
					name: projectName,
					main: 'worker/index.ts',
					compatibility_date: '2026-01-31',
					assets: {
						not_found_handling: 'single-page-application',
						run_worker_first: ['/api/*'],
					},
					observability: {
						enabled: true,
					},
				}, null, '\t');

				zipFiles[`${prefix}vite.config.ts`] = [
					'import { defineConfig } from \'vite\';',
					'import { cloudflare } from \'@cloudflare/vite-plugin\';',
					'',
					'export default defineConfig({',
					'\tplugins: [cloudflare()],',
					'});',
					'',
				].join('\n');

				const zip = createZip(zipFiles);
				return new Response(zip, {
					headers: {
						'Content-Type': 'application/zip',
						'Content-Disposition': `attachment; filename="${projectName}.zip"`,
						'Access-Control-Allow-Origin': '*',
					},
				});
			}

			// POST /api/agent/chat - AI coding agent with SSE streaming
			if (path === '/api/agent/chat' && request.method === 'POST') {
				return this.handleAgentChat(request, projectId);
			}

			return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
		} catch (err) {
			return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
		}
	}

	private async serveFile(request: Request, options?: { baseHref?: string; projectId?: string }): Promise<Response> {
		const url = new URL(request.url);
		let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

		// Check for raw query param (used by HMR for CSS)
		const isRawRequest = url.searchParams.has('raw');

		// Strip query params for file lookup
		filePath = filePath.split('?')[0];

		const baseUrl = options?.baseHref?.replace(/\/$/, '') || '';

		// Create filesystem adapter for vite-dev
		const viteFs: FileSystem = {
			readFile: (path: string) => fs.readFile(path),
			access: (path: string) => fs.access(path),
		};

		try {
			// Resolve extensionless imports
			let fullPath = `${this.projectRoot}${filePath}`;
			const initialExt = getExtension(filePath);

			if (!initialExt) {
				const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts'];
				let resolved = false;

				const directResults = await Promise.allSettled(
					extensions.map(tryExt => fs.access(fullPath + tryExt).then(() => tryExt))
				);
				for (const result of directResults) {
					if (result.status === 'fulfilled') {
						fullPath = fullPath + result.value;
						filePath = filePath + result.value;
						resolved = true;
						break;
					}
				}

				if (!resolved) {
					const indexResults = await Promise.allSettled(
						extensions.map(tryExt => fs.access(fullPath + '/index' + tryExt).then(() => tryExt))
					);
					for (const result of indexResults) {
						if (result.status === 'fulfilled') {
							fullPath = fullPath + '/index' + result.value;
							filePath = filePath + '/index' + result.value;
							resolved = true;
							break;
						}
					}
				}

				if (!resolved) {
					throw new Error(`ENOENT: no such file or directory, '${filePath}'`);
				}
			}

			const content = await fs.readFile(fullPath);
			const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content as unknown as Uint8Array);
			const ext = getExtension(filePath);

			// Handle HTML files - use processHTML for proper script/link rewriting
			if (ext === '.html') {
				const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
				// Extract project prefix from baseUrl (e.g., /p/abc123/preview -> /p/abc123)
				const projectPrefix = baseUrl.replace(/\/preview\/?$/, '');
				const hmrUrl = `${protocol}//${url.host}${projectPrefix}/__hmr`;
				const html = await processHTML(textContent, filePath, {
					fs: viteFs,
					projectRoot: this.projectRoot,
					baseUrl,
					hmrUrl,
				});
				return new Response(html, {
					headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
				});
			}

			// Serve raw CSS for HMR updates (no transformation to JS module)
			if (isRawRequest && ext === '.css') {
				return new Response(textContent, {
					headers: {
						'Content-Type': 'text/css',
						'Cache-Control': 'no-cache',
					},
				});
			}

			// Handle JS/TS/CSS/JSON - use transformModule for import rewriting
			const transformed = await transformModule(filePath, textContent, {
				fs: viteFs,
				projectRoot: this.projectRoot,
				baseUrl,
			});

			return new Response(transformed.code, {
				headers: {
					'Content-Type': transformed.contentType,
					'Cache-Control': 'no-cache',
				},
			});
		} catch (err) {
			console.error('serveFile error:', err);
			const errMsg = String(err);
			const locMatch = errMsg.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);
			const serverErr: ServerError = {
				timestamp: Date.now(),
				type: 'bundle',
				message: errMsg,
				file: locMatch ? locMatch[1] : undefined,
				line: locMatch ? Number(locMatch[2]) : undefined,
				column: locMatch ? Number(locMatch[3]) : undefined,
			};
			if (options?.projectId) {
				await this.broadcastMessage(options.projectId, { type: 'server-error', error: serverErr }).catch(() => {});
			}
			const errJson = JSON.stringify(serverErr).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
			const errorModule = `if (typeof showErrorOverlay === 'function') { showErrorOverlay(${errJson}); } else { console.error(${errJson}.message); }`;
			return new Response(errorModule, {
				headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
			});
		}
	}

	private async handlePreviewAPI(request: Request, apiPath: string, projectId: string): Promise<Response> {
		try {
			const files = await this.collectFilesForBundle(`${this.projectRoot}/worker`, 'worker');

			// Check if worker/index.ts exists
			const workerEntry = Object.keys(files).find(f =>
				f === 'worker/index.ts' || f === 'worker/index.js'
			);

			if (!workerEntry) {
				const err: ServerError = { timestamp: Date.now(), type: 'bundle', message: 'No worker/index.ts found. Create a worker/index.ts file with a default export { fetch }.' };
				this.setLastBroadcastWasError(projectId, true);
				await this.broadcastMessage(projectId, { type: 'server-error', error: err }).catch(() => {});
				return Response.json({ error: err.message, serverError: err }, { status: 500 });
			}

			const workerFiles = Object.entries(files)
				.sort(([a], [b]) => a.localeCompare(b));
			const contentHash = await this.hashContent(JSON.stringify(workerFiles));

			// Transform is deferred into getCode — only runs if no warm isolate exists for this hash
			let logBinding: ReturnType<NonNullable<(typeof this.ctx.exports)['LogTailer']>> | null = null;
			try {
				logBinding = this.ctx.exports.LogTailer({ props: { projectId } });
			} catch (e) {
				console.warn('LogTailer binding unavailable, tail logs disabled:', e);
			}
			const worker = this.env.LOADER.get(`worker:${contentHash}`, async () => {
				const modules: Record<string, string> = {};
				for (const [filePath, content] of workerFiles) {
					// Convert .ts/.tsx/.jsx to .js for the module name
					const jsPath = filePath.replace(/\.(ts|tsx|jsx|mts)$/, '.js');
					const needsTransform = /\.(ts|tsx|jsx|mts)$/.test(filePath);
					let code = content;
					if (needsTransform) {
						const result = await transformCode(code, filePath, { sourcemap: false });
						code = result.code;
					}
					// Rewrite import specifiers to use .js extensions
					code = code.replace(
						/(from\s+['"])(\.\.\/|\.\/)([^'"]+?)(\.ts|\.tsx|\.jsx|\.mts)?(['"])/g,
						(match, pre, rel, rest, ext, quote) => {
							const hasJsExt = rest.endsWith('.js') || rest.endsWith('.mjs');
							if (ext) return `${pre}${rel}${rest}.js${quote}`;
							if (hasJsExt) return match;
							return `${pre}${rel}${rest}.js${quote}`;
						}
					);
					modules[jsPath] = code;
				}
				return {
					compatibilityDate: '2026-01-31',
					mainModule: 'worker/index.js',
					modules,
					...(logBinding ? { tails: [logBinding] } : {}),
				};
			});

			// Create a new request with the correct path (strip /preview prefix)
			const apiUrl = new URL(request.url);
			apiUrl.pathname = apiPath;
			const apiRequest = new Request(apiUrl.toString(), request);

			const entrypoint = worker.getEntrypoint();
			const response = await entrypoint.fetch(apiRequest);
			if (this.lastBroadcastWasErrorMap.get(projectId)) {
				this.setLastBroadcastWasError(projectId, false);
				await this.broadcastMessage(projectId, { type: 'server-ok' }).catch(() => {});
			}
			return response;
		} catch (err) {
			const errMsg = String(err);
			const isBundleError = errMsg.includes('ERROR:');
			const locMatch = errMsg.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);
			let file = locMatch ? locMatch[1] : undefined;
			let line = locMatch ? Number(locMatch[2]) : undefined;
			let column = locMatch ? Number(locMatch[3]) : undefined;
			if (!file && err instanceof Error && err.stack) {
				const stackLines = err.stack.split('\n');
				for (const stackLine of stackLines) {
					const m = stackLine.match(/at\s+.*?\(?([\w./\-]+\.(?:js|ts|mjs|tsx|jsx)):(\d+):(\d+)\)?/);
					if (m && /^worker\//.test(m[1])) {
						file = m[1];
						line = Number(m[2]);
						column = Number(m[3]);
						break;
					}
				}
			}
			const serverErr: ServerError = {
				timestamp: Date.now(),
				type: isBundleError ? 'bundle' : 'runtime',
				message: errMsg,
				file,
				line,
				column,
			};
			this.setLastBroadcastWasError(projectId, true);
			await this.broadcastMessage(projectId, { type: 'server-error', error: serverErr }).catch(() => {});
			console.error('Server code execution error:', err);
			return Response.json({ error: errMsg, serverError: serverErr }, { status: 500 });
		}
	}

	private async hashContent(content: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(content);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	private async listFilesRecursive(dir: string, base = ''): Promise<string[]> {
		const files: string[] = [];
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const relativePath = base ? `${base}/${entry.name}` : `/${entry.name}`;
				if (entry.isDirectory()) {
					files.push(...(await this.listFilesRecursive(`${dir}/${entry.name}`, relativePath)));
				} else {
					files.push(relativePath);
				}
			}
		} catch (err) {
			if (base === '') {
				console.error('listFilesRecursive error:', err);
			}
		}
		return files;
	}

	private async collectFilesForBundle(dir: string, base = ''): Promise<Record<string, string>> {
		const files: Record<string, string> = {};
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			const results = await Promise.all(
				entries.map(async (entry) => {
					const relativePath = base ? `${base}/${entry.name}` : entry.name;
					const fullPath = `${dir}/${entry.name}`;
					if (entry.isDirectory()) {
						return this.collectFilesForBundle(fullPath, relativePath);
					} else {
						const content = await fs.readFile(fullPath, 'utf8');
						return { [relativePath]: content };
					}
				})
			);
			for (const result of results) {
				Object.assign(files, result);
			}
		} catch (err) {
			if (base === '') {
				console.error('collectFilesForBundle error:', err);
			}
		}
		return files;
	}

	// AI Agent Chat Handler
	private async handleAgentChat(request: Request, projectId: string): Promise<Response> {
		// Check for API token
		const apiToken = this.env.REPLICATE_API_TOKEN;
		if (!apiToken) {
			return new Response(JSON.stringify({ error: 'REPLICATE_API_TOKEN not configured. Please set it using: wrangler secret put REPLICATE_API_TOKEN' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const body = await request.json() as { prompt: string; history?: AgentMessage[] };
		const { prompt, history = [] } = body;

		if (!prompt || typeof prompt !== 'string') {
			return new Response(JSON.stringify({ error: 'prompt is required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Create SSE stream
		const encoder = new TextEncoder();
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();

		const sendEvent = async (type: string, data: Record<string, unknown>) => {
			const event = `data: ${JSON.stringify({ type, ...data })}\n\n`;
			await writer.write(encoder.encode(event));
		};

		// Run agent loop in background
		const signal = request.signal;
		this.runAgentLoop(writer, encoder, sendEvent, prompt, history, projectId, apiToken, signal).catch(async (err) => {
			console.error('Agent error:', err);
			try {
				await sendEvent('error', { message: String(err) });
				await writer.close();
			} catch {}
		});

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'Access-Control-Allow-Origin': '*',
			},
		});
	}

	private async runAgentLoop(
		writer: WritableStreamDefaultWriter<Uint8Array>,
		encoder: TextEncoder,
		sendEvent: (type: string, data: Record<string, unknown>) => Promise<void>,
		prompt: string,
		history: AgentMessage[],
		projectId: string,
		apiToken: string,
		signal?: AbortSignal
	): Promise<void> {
		try {
			await sendEvent('status', { message: 'Starting...' });

			// Build messages array for Claude
			const messages: Array<{ role: string; content: string | ContentBlock[] }> = [];

			// Add history
			for (const msg of history) {
				messages.push({ role: msg.role, content: msg.content });
			}

			// Add current prompt
			messages.push({ role: 'user', content: prompt });

			let continueLoop = true;
			let maxIterations = 10; // Prevent infinite loops
			let iteration = 0;
			let assistantResponse = '';

			while (continueLoop && iteration < maxIterations) {
				if (signal?.aborted) {
					await sendEvent('status', { message: 'Interrupted' });
					break;
				}
				iteration++;
				await sendEvent('status', { message: 'Thinking...' });

				// Call Claude via Replicate API
				const response = await this.callClaude(messages, apiToken, signal);

				if (!response) {
					throw new Error('Failed to get response from Claude');
				}

				// Process the response
				let hasToolUse = false;
				const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

				for (const block of response.content) {
					if (block.type === 'text') {
						assistantResponse += block.text;
						await sendEvent('message', { content: block.text });
					} else if (block.type === 'tool_use') {
						hasToolUse = true;
						const toolCall = block as ToolUseBlock;

						await sendEvent('tool_call', {
							tool: toolCall.name,
							id: toolCall.id,
							args: toolCall.input
						});

						// Execute the tool
						const result = await this.executeAgentTool(toolCall.name, toolCall.input, projectId, sendEvent);

						await sendEvent('tool_result', {
							tool: toolCall.name,
							tool_use_id: toolCall.id,
							result: typeof result === 'string' ? result : JSON.stringify(result)
						});

						toolResults.push({
							type: 'tool_result',
							tool_use_id: toolCall.id,
							content: typeof result === 'string' ? result : JSON.stringify(result),
						});
					}
				}

				// If there were tool uses, add assistant response and tool results, then continue
				if (hasToolUse) {
					messages.push({ role: 'assistant', content: response.content });
					messages.push({ role: 'user', content: toolResults as unknown as ContentBlock[] });
				} else {
					// No tool use, we're done
					continueLoop = false;
				}

				// Check stop reason
				if (response.stop_reason === 'end_turn' && !hasToolUse) {
					continueLoop = false;
				}

				await sendEvent('turn_complete', {});
			}

			await sendEvent('done', {});
			await writer.close();
		} catch (err) {
			console.error('Agent loop error:', err);
			await sendEvent('error', { message: String(err) });
			await writer.close();
		}
	}

	private async callClaude(
		messages: Array<{ role: string; content: string | ContentBlock[] }>,
		apiToken: string,
		signal?: AbortSignal
	): Promise<ClaudeResponse | null> {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		const replicate = new Replicate({ auth: apiToken });

		// Format the conversation for Replicate's Claude model
		let formattedPrompt = '';
		for (const msg of messages) {
			if (msg.role === 'user') {
				if (typeof msg.content === 'string') {
					formattedPrompt += `\n\nHuman: ${msg.content}`;
				} else {
					// Handle tool results
					const toolResults = msg.content as unknown as Array<{ type: 'tool_result'; tool_use_id: string; content: string }>;
					let resultsText = '';
					for (const result of toolResults) {
						const resultContent = typeof result.content === 'string'
							? (result.content.length > 2000 ? result.content.slice(0, 2000) + '\n... (truncated)' : result.content)
							: JSON.stringify(result.content);
						resultsText += `\n[Tool Result for ${result.tool_use_id}]:\n${resultContent}\n[/Tool Result]`;
					}
					formattedPrompt += `\n\nHuman: ${resultsText}`;
				}
			} else if (msg.role === 'assistant') {
				if (typeof msg.content === 'string') {
					formattedPrompt += `\n\nAssistant: ${msg.content}`;
				} else {
					// Handle assistant content blocks
					let assistantText = '';
					for (const block of msg.content as ContentBlock[]) {
						if (block.type === 'text') {
							assistantText += block.text;
						} else if (block.type === 'tool_use') {
							assistantText += `\n<tool_use>\n{"name": "${block.name}", "input": ${JSON.stringify(block.input)}}\n</tool_use>`;
						}
					}
					formattedPrompt += `\n\nAssistant: ${assistantText}`;
				}
			}
		}
		formattedPrompt += '\n\nAssistant:';

		// Build the full prompt with system instructions and tool definitions
		const toolsDescription = AGENT_TOOLS.map(t =>
			`- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.input_schema.properties)}`
		).join('\n');

		const fullSystemPrompt = `${AGENT_SYSTEM_PROMPT}

Available tools:
${toolsDescription}

IMPORTANT: To use a tool, respond with a JSON block in this exact format:
<tool_use>
{"name": "tool_name", "input": {"param1": "value1"}}
</tool_use>

You can use multiple tools in sequence. After using a tool, you will receive the result and can continue your response.
When you're done and don't need to use any more tools, just provide your final response without any tool_use blocks.`;

		const fullPrompt = `${fullSystemPrompt}${formattedPrompt}`;

		// Use Replicate client with streaming
		let output = '';
		for await (const event of replicate.stream('anthropic/claude-4.5-haiku', {
			input: {
				prompt: fullPrompt,
				max_tokens: 4096,
				system_prompt: '',
			},
		})) {
			if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
			output += event.toString();
		}

		// Parse the output to extract tool uses and text
		const content: ContentBlock[] = [];

		// Check for tool_use blocks using balanced brace extraction
		let lastIndex = 0;
		let toolUseCount = 0;
		const openTag = '<tool_use>';
		const closeTag = '</tool_use>';
		let searchFrom = 0;

		while (searchFrom < output.length) {
			const tagStart = output.indexOf(openTag, searchFrom);
			if (tagStart === -1) break;

			const jsonStart = tagStart + openTag.length;
			const tagEnd = output.indexOf(closeTag, jsonStart);
			if (tagEnd === -1) break;

			const jsonStr = output.slice(jsonStart, tagEnd).trim();
			const blockEnd = tagEnd + closeTag.length;

			// Add text before the tool use
			const textBefore = output.slice(lastIndex, tagStart).trim();
			if (textBefore) {
				content.push({ type: 'text', text: textBefore });
			}

			// Parse and add the tool use
			try {
				const toolData = JSON.parse(jsonStr) as { name: string; input: Record<string, string> };
				content.push({
					type: 'tool_use',
					id: `tool_${Date.now()}_${toolUseCount++}`,
					name: toolData.name,
					input: toolData.input,
				});
			} catch (e) {
				console.error('Failed to parse tool use:', jsonStr, e);
				content.push({ type: 'text', text: output.slice(tagStart, blockEnd) });
			}

			lastIndex = blockEnd;
			searchFrom = blockEnd;
		}

		// Add remaining text
		const remainingText = output.slice(lastIndex).trim();
		if (remainingText) {
			content.push({ type: 'text', text: remainingText });
		}

		// If no content was parsed, add the whole output as text
		if (content.length === 0) {
			content.push({ type: 'text', text: output });
		}

		const hasToolUse = content.some(c => c.type === 'tool_use');

		return {
			id: `resp_${Date.now()}`,
			type: 'message',
			role: 'assistant',
			content,
			stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
			stop_sequence: null,
		};
	}

	private async executeAgentTool(
		toolName: string,
		toolInput: Record<string, string>,
		projectId: string,
		sendEvent: (type: string, data: Record<string, unknown>) => Promise<void>
	): Promise<string | object> {
		try {
			switch (toolName) {
				case 'list_files': {
					await sendEvent('status', { message: 'Listing files...' });
					const files = await this.listFilesRecursive(this.projectRoot);
					// Filter out .initialized
					const filtered = files.filter(f => !f.endsWith('/.initialized') && f !== '/.initialized');
					return { files: filtered };
				}

				case 'read_file': {
					const path = toolInput.path;
					if (!path || !isPathSafe(this.projectRoot, path)) {
						return { error: 'Invalid file path' };
					}
					await sendEvent('status', { message: `Reading ${path}...` });
					try {
						const content = await fs.readFile(`${this.projectRoot}${path}`, 'utf8');
						return { path, content };
					} catch (err) {
						return { error: `File not found: ${path}` };
					}
				}

				case 'write_file': {
					const path = toolInput.path;
					const content = toolInput.content;
					if (!path || !isPathSafe(this.projectRoot, path)) {
						return { error: 'Invalid file path' };
					}
					if (content === undefined) {
						return { error: 'Content is required' };
					}
					await sendEvent('status', { message: `Writing ${path}...` });

					// Ensure directory exists
					const dir = path.substring(0, path.lastIndexOf('/'));
					if (dir) {
						await fs.mkdir(`${this.projectRoot}${dir}`, { recursive: true });
					}

					// Check if file exists (for action type)
					let action: 'create' | 'edit' = 'create';
					try {
						await fs.access(`${this.projectRoot}${path}`);
						action = 'edit';
					} catch {
						action = 'create';
					}

					await fs.writeFile(`${this.projectRoot}${path}`, content);

					// Trigger HMR
					const hmrId = this.env.DO_HMR_COORDINATOR.idFromName(`hmr:${projectId}`);
					const hmrStub = this.env.DO_HMR_COORDINATOR.get(hmrId);
					const isCSS = path.endsWith('.css');
					await hmrStub.fetch(new Request('http://internal/hmr/trigger', {
						method: 'POST',
						body: JSON.stringify({
							type: isCSS ? 'update' : 'full-reload',
							path,
							timestamp: Date.now(),
							isCSS,
						}),
					}));

					await sendEvent('file_changed', { path, action });
					return { success: true, path, action };
				}

				case 'delete_file': {
					const path = toolInput.path;
					if (!path || !isPathSafe(this.projectRoot, path)) {
						return { error: 'Invalid file path' };
					}
					await sendEvent('status', { message: `Deleting ${path}...` });
					try {
						await fs.unlink(`${this.projectRoot}${path}`);
						await sendEvent('file_changed', { path, action: 'delete' });
						return { success: true, path, action: 'delete' };
					} catch (err) {
						return { error: `Failed to delete: ${path}` };
					}
				}

				case 'move_file': {
					const fromPath = toolInput.from_path;
					const toPath = toolInput.to_path;
					if (!fromPath || !isPathSafe(this.projectRoot, fromPath)) {
						return { error: 'Invalid source path' };
					}
					if (!toPath || !isPathSafe(this.projectRoot, toPath)) {
						return { error: 'Invalid destination path' };
					}
					await sendEvent('status', { message: `Moving ${fromPath} to ${toPath}...` });

					try {
						// Read source file
						const content = await fs.readFile(`${this.projectRoot}${fromPath}`);

						// Ensure destination directory exists
						const destDir = toPath.substring(0, toPath.lastIndexOf('/'));
						if (destDir) {
							await fs.mkdir(`${this.projectRoot}${destDir}`, { recursive: true });
						}

						// Write to destination (preserve binary content)
						await fs.writeFile(`${this.projectRoot}${toPath}`, content);

						// Delete source
						await fs.unlink(`${this.projectRoot}${fromPath}`);

						await sendEvent('file_changed', { path: fromPath, action: 'delete' });
						await sendEvent('file_changed', { path: toPath, action: 'create' });

						return { success: true, from: fromPath, to: toPath };
					} catch (err) {
						return { error: `Failed to move file: ${String(err)}` };
					}
				}

				default:
					return { error: `Unknown tool: ${toolName}` };
			}
		} catch (err) {
			console.error(`Tool execution error (${toolName}):`, err);
			return { error: String(err) };
		}
	}
}
