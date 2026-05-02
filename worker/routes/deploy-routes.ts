import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import stripJsonComments from 'strip-json-comments';
import { z } from 'zod';

import { HIDDEN_ENTRIES, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { sanitizeR2BucketName, sanitizeWorkerName } from '@shared/deploy-helpers';
import { HttpErrorCode } from '@shared/http-errors';
import { resolveAssetSettings } from '@shared/types';
import { deployRequestSchema } from '@shared/validation';

import * as schema from '../db/auth-schema';
import { trackProjectEvent } from '../lib/analytics';
import { getContentType } from '../lib/content-type';
import { httpError } from '../lib/http-error';
import { readAssetSettings, readBindingsConfig, readDependencies, readProjectName } from '../lib/protected-files';
import { bundleWithCdn } from '../services/bundler-client';
import { toEsbuildTsconfigRaw } from '../services/transform-service';

import type { AppEnvironment } from '../types';
import type { AssetSettings } from '@shared/types';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const assetUploadSessionResponseSchema = z.object({
	result: z
		.object({
			jwt: z.string().optional(),
			buckets: z.array(z.array(z.string())).optional(),
		})
		.optional(),
});
const assetUploadResponseSchema = z.object({
	result: z
		.object({
			jwt: z.string().optional(),
		})
		.optional(),
});
const workersSubdomainResponseSchema = z.object({
	result: z
		.object({
			subdomain: z.string().optional(),
		})
		.optional(),
});

function parseUpstreamResponse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, message);
	}

	return parsed.data;
}

export const deployRoutes = new Hono<AppEnvironment>().post('/deploy', zValidator('json', deployRequestSchema), async (c) => {
	const deployStart = Date.now();
	const { accountId, apiToken, workerName } = c.req.valid('json');

	// Look up the project's organizationId for analytics
	const deployDatabase = drizzle(c.env.DB, { schema });
	const deployProjectRow = await deployDatabase
		.select({ organizationId: schema.project.organizationId })
		.from(schema.project)
		.where(eq(schema.project.id, c.get('projectId')))
		.limit(1);
	const deployOrganizationId = deployProjectRow[0]?.organizationId ?? '';

	const projectRoot = c.get('projectRoot');

	try {
		// Read project config from canonical files via shared helpers
		const projectName = await readProjectName(projectRoot);
		const assetSettings = await readAssetSettings(projectRoot);
		const bindingsConfig = await readBindingsConfig(projectRoot);
		const dependenciesRecord = await readDependencies(projectRoot);
		const registeredDependencies = new Map(Object.entries(dependenciesRecord));

		const sanitizedWorkerName = sanitizeWorkerName(workerName || projectName);

		// Load tsconfig for esbuild
		const tsconfigRaw = await loadTsconfigRaw(projectRoot);

		// Collect all project files
		const allFiles = await collectProjectFiles(projectRoot);

		// =========================================================================
		// Step 1: Bundle the worker code
		// =========================================================================
		const workerFiles = await collectProjectFiles(`${projectRoot}/worker`, 'worker');
		// Also include root-level files that worker code might import
		const workerBundleFiles: Record<string, string> = { ...workerFiles };
		// Add any shared files the worker might reference
		for (const [filePath, content] of Object.entries(allFiles)) {
			if (!filePath.startsWith('src/') && !(filePath in workerBundleFiles)) {
				workerBundleFiles[filePath] = content;
			}
		}

		const workerEntry = findWorkerEntryPoint(workerBundleFiles);
		if (!workerEntry) {
			throw httpError(
				HttpErrorCode.VALIDATION_ERROR,
				'No worker entry point found. Expected worker/index.ts, worker/index.js, src/index.ts, or index.ts',
			);
		}

		let bundledWorkerCode: string;
		try {
			const workerBundle = await bundleWithCdn({
				files: workerBundleFiles,
				entryPoint: workerEntry,
				platform: 'neutral',
				minify: true,
				knownDependencies: registeredDependencies,
				tsconfigRaw,
			});
			bundledWorkerCode = workerBundle.code;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw httpError(HttpErrorCode.BUILD_FAILED, `Failed to bundle worker code: ${message}`);
		}

		// =========================================================================
		// Step 2: Detect and bundle frontend assets
		// =========================================================================
		const staticAssets = new Map<string, Uint8Array>();
		const hasIndexHtml = 'index.html' in allFiles;

		if (hasIndexHtml) {
			const indexHtml = allFiles['index.html'];

			// Extract the frontend entry point from the HTML <script> tag
			const frontendEntry = extractFrontendEntryPoint(indexHtml);

			if (frontendEntry && frontendEntry in allFiles) {
				// Bundle the frontend code
				const sourceFiles = await collectProjectFiles(`${projectRoot}/src`, 'src');
				const frontendBundleFiles: Record<string, string> = { ...sourceFiles };
				// Include any root-level files that might be imported
				for (const [filePath, content] of Object.entries(allFiles)) {
					if (!(filePath in frontendBundleFiles) && !filePath.startsWith('worker/')) {
						frontendBundleFiles[filePath] = content;
					}
				}

				let bundledFrontendCode: string;
				try {
					const frontendBundle = await bundleWithCdn({
						files: frontendBundleFiles,
						entryPoint: frontendEntry,
						platform: 'browser',
						minify: true,
						knownDependencies: registeredDependencies,
						tsconfigRaw,
					});
					bundledFrontendCode = frontendBundle.code;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw httpError(HttpErrorCode.BUILD_FAILED, `Failed to bundle frontend code: ${message}`);
				}

				// Generate content hash for cache busting
				const frontendHash = await hashContent(bundledFrontendCode);
				const bundleFilename = `assets/bundle-${frontendHash.slice(0, 8)}.js`;

				// Add the bundled JS as a static asset
				staticAssets.set(`/${bundleFilename}`, new TextEncoder().encode(bundledFrontendCode));

				// Generate production HTML with the bundled script reference
				const productionHtml = generateProductionHtml(indexHtml, frontendEntry, `/${bundleFilename}`);
				staticAssets.set('/index.html', new TextEncoder().encode(productionHtml));
			} else {
				// No frontend entry point detected — just serve the raw HTML as-is
				staticAssets.set('/index.html', new TextEncoder().encode(indexHtml));
			}

			// Add any other static files (CSS, images, etc.) that aren't TS/TSX/worker code
			for (const filePath of Object.keys(allFiles)) {
				const assetPath = `/${filePath}`;
				if (staticAssets.has(assetPath)) continue;
				if (filePath.startsWith('worker/')) continue;
				if (filePath === 'index.html') continue;
				// Skip source files that were bundled
				if (isSourceFile(filePath)) continue;
				// Skip config/meta files that shouldn't be publicly served
				if (isConfigFile(filePath)) continue;

				// Read as binary to avoid corrupting non-text files (images, fonts, etc.)
				staticAssets.set(assetPath, await readFileBinary(`${projectRoot}/${filePath}`));
			}
		}

		// =========================================================================
		// Step 3: Upload static assets (if any)
		// =========================================================================
		let assetsCompletionJwt: string | undefined;
		const hasAssets = staticAssets.size > 0;

		if (hasAssets) {
			assetsCompletionJwt = await uploadStaticAssets(accountId.trim(), apiToken.trim(), sanitizedWorkerName, staticAssets);
		}

		// =========================================================================
		// Step 4: Deploy the worker script
		// =========================================================================
		// If the project uses object storage, auto-create an R2 bucket
		let r2BucketName: string | undefined;
		if (bindingsConfig.storage) {
			r2BucketName = sanitizeR2BucketName(sanitizedWorkerName);
			await ensureR2Bucket(accountId.trim(), apiToken.trim(), r2BucketName);
		}

		await uploadWorkerScript(
			accountId.trim(),
			apiToken.trim(),
			sanitizedWorkerName,
			bundledWorkerCode,
			assetsCompletionJwt,
			assetSettings,
			r2BucketName,
		);

		// =========================================================================
		// Step 5: Enable the workers.dev subdomain route
		// =========================================================================
		await enableWorkersDevelopmentSubdomain(accountId.trim(), apiToken.trim(), sanitizedWorkerName);

		// Get the workers.dev URL
		const workerUrl = await getWorkersDevelopmentUrl(accountId.trim(), apiToken.trim(), sanitizedWorkerName);

		trackProjectEvent({
			organizationId: deployOrganizationId,
			eventType: 'deploy',
			projectId: c.get('projectId'),
			userId: c.get('session').userId,
			detail: sanitizedWorkerName,
			durationMs: Date.now() - deployStart,
			success: true,
			request: c.req.raw,
		});

		return c.json({
			success: true,
			workerName: sanitizedWorkerName,
			workerUrl,
		});
	} catch (error) {
		trackProjectEvent({
			organizationId: deployOrganizationId,
			eventType: 'deploy',
			projectId: c.get('projectId'),
			userId: c.get('session').userId,
			error: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - deployStart,
			success: false,
			request: c.req.raw,
		});
		throw error;
	}
});

async function collectProjectFiles(directory: string, base = ''): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const results = await Promise.all(
			entries
				.filter((entry: { name: string }) => !HIDDEN_ENTRIES.has(entry.name))
				.map(async (entry: { name: string; isDirectory: () => boolean }) => {
					const relativePath = base ? `${base}/${entry.name}` : entry.name;
					const fullPath = `${directory}/${entry.name}`;
					if (entry.isDirectory()) {
						return collectProjectFiles(fullPath, relativePath);
					} else {
						const content = await fs.readFile(fullPath, 'utf8');
						return { [relativePath]: content };
					}
				}),
		);
		for (const result of results) {
			Object.assign(files, result);
		}
	} catch (error) {
		if (base === '') {
			console.error('collectProjectFiles error:', error);
		}
	}
	return files;
}

async function readFileBinary(filePath: string): Promise<Uint8Array> {
	const buffer = await fs.readFile(filePath);
	return new Uint8Array(buffer);
}

function findWorkerEntryPoint(files: Record<string, string>): string | undefined {
	const candidates = [
		'worker/index.ts',
		'worker/index.js',
		'worker/index.mts',
		'worker/index.mjs',
		'src/index.ts',
		'src/index.js',
		'index.ts',
		'index.js',
	];
	return candidates.find((candidate) => candidate in files);
}

/**
 * Extract the frontend entry point path from an HTML file's <script> tag.
 * Looks for <script type="module" src="..."> or <script src="...">.
 */
function extractFrontendEntryPoint(html: string): string | undefined {
	// Match <script type="module" src="..."> or <script src="...">
	const scriptRegex = /<script[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
	let match: RegExpExecArray | null;
	while ((match = scriptRegex.exec(html)) !== null) {
		const source = match[1];
		// Skip external scripts and internal preview scripts
		if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('__')) {
			continue;
		}
		// Return the first local script source (strip leading /)
		return source.startsWith('/') ? source.slice(1) : source;
	}
	return undefined;
}
function isSourceFile(filePath: string): boolean {
	return /\.(ts|tsx|jsx|mts|mjs)$/.test(filePath) || (filePath.startsWith('src/') && filePath.endsWith('.js'));
}

const CONFIG_FILES = new Set([
	'.initialized',
	'tsconfig.json',
	'tsconfig.app.json',
	'tsconfig.worker.json',
	'package.json',
	'wrangler.jsonc',
	'vite.config.ts',
	'vitest.config.ts',
	'worker-env.d.ts',
	'package-lock.json',
	'bun.lockb',
	'.gitignore',
	'.eslintrc.json',
	'.prettierrc',
	'biome.json',
	'README.md',
	'readme.md',
]);

function isConfigFile(filePath: string): boolean {
	return CONFIG_FILES.has(filePath);
}
function generateProductionHtml(html: string, originalEntry: string, bundledPath: string): string {
	// Replace the original entry script source with the bundled path
	// Handle both quoted forms: src="..." and src='...'
	const escaped = originalEntry.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
	const regex = new RegExp(String.raw`(<script[^>]*\bsrc=["'])(?:/?${escaped})(["'][^>]*>)`, 'gi');
	return html.replace(regex, `$1${bundledPath}$2`);
}

async function loadTsconfigRaw(projectRoot: string): Promise<string | undefined> {
	try {
		const content = await fs.readFile(`${projectRoot}/tsconfig.json`, 'utf8');
		const tsConfig = JSON.parse(stripJsonComments(content));

		// If the root tsconfig is a solution-style project references file (no compilerOptions),
		// try loading tsconfig.app.json which has the frontend compiler settings (jsx, etc.)
		if (!tsConfig.compilerOptions) {
			try {
				const appContent = await fs.readFile(`${projectRoot}/tsconfig.app.json`, 'utf8');
				return toEsbuildTsconfigRaw(JSON.parse(stripJsonComments(appContent)));
			} catch {
				return undefined;
			}
		}

		return toEsbuildTsconfigRaw(tsConfig);
	} catch {
		return undefined;
	}
}

async function hashContent(content: string): Promise<string> {
	const data = new TextEncoder().encode(content);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = [...new Uint8Array(hashBuffer)];
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash file content for the Cloudflare asset manifest.
 * The hash is used as a consistent identifier — the manifest hash must match the
 * form field name used during upload. We use SHA-256 of (base64(content) + extension),
 * truncated to 32 hex chars.
 */
async function hashFileForManifest(content: Uint8Array, filePath: string): Promise<string> {
	const extension = filePath.split('.').pop() || '';
	const base64Content = uint8ArrayToBase64(content);
	const data = new TextEncoder().encode(base64Content + extension + filePath);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = [...new Uint8Array(hashBuffer)];
	return hashArray
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCodePoint(byte);
	}
	return btoa(binary);
}

/**
 * Ensure an R2 bucket exists in the user's Cloudflare account.
 * Checks if the bucket already exists; creates it if not.
 */
async function ensureR2Bucket(accountId: string, apiToken: string, bucketName: string): Promise<void> {
	// Check if bucket already exists
	const checkResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`, {
		headers: { Authorization: `Bearer ${apiToken}` },
	});

	if (checkResponse.ok) {
		return; // Bucket already exists
	}

	// Create the bucket (ignore 409 Conflict — means it already exists)
	const createResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/r2/buckets`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ name: bucketName }),
	});

	if (!createResponse.ok && createResponse.status !== 409) {
		const errorText = await createResponse.text();
		throw httpError(
			HttpErrorCode.UPSTREAM_ERROR,
			`Failed to create R2 bucket "${bucketName}": ${extractApiError(errorText, createResponse.status)}`,
		);
	}
}

/**
 * Upload static assets to the user's Cloudflare account via the Direct Upload API.
 * Returns the completion JWT needed for the final worker script upload.
 *
 * Flow:
 * 1. POST manifest → get upload JWT + buckets
 * 2. POST file contents in batches → get completion JWT
 */
async function uploadStaticAssets(
	accountId: string,
	apiToken: string,
	workerName: string,
	assets: Map<string, Uint8Array>,
): Promise<string> {
	// Build the manifest
	const manifest: Record<string, { hash: string; size: number }> = {};
	const hashToPath = new Map<string, string>();
	const hashToContent = new Map<string, Uint8Array>();

	for (const [filePath, content] of assets) {
		const hash = await hashFileForManifest(content, filePath);
		manifest[filePath] = { hash, size: content.byteLength };
		hashToPath.set(hash, filePath);
		hashToContent.set(hash, content);
	}

	// Step 1: Create upload session with manifest
	const sessionResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}/assets-upload-session`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ manifest }),
	});

	if (!sessionResponse.ok) {
		const errorText = await sessionResponse.text();
		throw httpError(
			HttpErrorCode.UPSTREAM_ERROR,
			`Failed to create asset upload session: ${extractApiError(errorText, sessionResponse.status)}`,
		);
	}

	const sessionData = parseUpstreamResponse(
		assetUploadSessionResponseSchema,
		await sessionResponse.json(),
		'Asset upload session returned an invalid response',
	);

	const uploadJwt = sessionData.result?.jwt;
	const buckets = sessionData.result?.buckets;

	if (!uploadJwt) {
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Asset upload session did not return a JWT');
	}

	// If buckets is empty, all files already exist — use the upload JWT as completion JWT
	if (!buckets || buckets.length === 0) {
		return uploadJwt;
	}

	// Step 2: Upload files in batches as instructed by the API
	let completionJwt: string | undefined;

	for (const bucket of buckets) {
		const formData = new FormData();
		for (const hash of bucket) {
			const content = hashToContent.get(hash);
			const filePath = hashToPath.get(hash);
			if (content && filePath) {
				const mimeType = getContentType(filePath);
				formData.append(hash, new File([uint8ArrayToBase64(content)], hash, { type: mimeType }), hash);
			}
		}

		const uploadResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/assets/upload?base64=true`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${uploadJwt}`,
			},
			body: formData,
		});

		if (!uploadResponse.ok) {
			const errorText = await uploadResponse.text();
			throw httpError(HttpErrorCode.UPSTREAM_ERROR, `Failed to upload assets: ${extractApiError(errorText, uploadResponse.status)}`);
		}

		const uploadData = parseUpstreamResponse(
			assetUploadResponseSchema,
			await uploadResponse.json(),
			'Asset upload returned an invalid response',
		);
		if (uploadData.result?.jwt) {
			completionJwt = uploadData.result.jwt;
		}
	}

	if (!completionJwt) {
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Asset upload completed but no completion JWT was received');
	}

	return completionJwt;
}

/**
 * Upload the bundled worker script to the user's Cloudflare account.
 * Includes the assets completion JWT if static assets were uploaded.
 */
async function uploadWorkerScript(
	accountId: string,
	apiToken: string,
	workerName: string,
	workerCode: string,
	assetsCompletionJwt: string | undefined,
	assetSettings?: AssetSettings,
	r2BucketName?: string,
): Promise<void> {
	const formData = new FormData();

	// Build metadata — asset config matches the generated wrangler.jsonc from the download route
	interface DeployMetadata {
		main_module: string;
		compatibility_date: string;
		compatibility_flags: string[];
		observability: { enabled: boolean };
		assets?: {
			jwt: string;
			config: {
				not_found_handling?: string;
				html_handling?: string;
				run_worker_first?: boolean | string[];
			};
		};
		bindings?: Array<{ type: string; name: string; bucket_name?: string }>;
	}

	const metadata: DeployMetadata = {
		main_module: 'worker.mjs',
		compatibility_date: WORKERS_COMPATIBILITY_DATE,
		compatibility_flags: ['nodejs_compat'],
		observability: { enabled: true },
	};

	if (assetsCompletionJwt) {
		metadata.assets = {
			jwt: assetsCompletionJwt,
			config: resolveAssetSettings(assetSettings),
		};
		metadata.bindings = [{ type: 'assets', name: 'ASSETS' }];
	}

	// Add R2 binding if the user provided a bucket name
	if (r2BucketName) {
		if (!metadata.bindings) {
			metadata.bindings = [];
		}
		metadata.bindings.push({ type: 'r2_bucket', name: 'STORAGE', bucket_name: r2BucketName });
	}

	formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));

	// Add the bundled worker script
	formData.append('worker.mjs', new Blob([workerCode], { type: 'application/javascript+module' }), 'worker.mjs');

	const uploadUrl = `${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`;

	const uploadResponse = await fetch(uploadUrl, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${apiToken}` },
		body: formData,
	});

	if (!uploadResponse.ok) {
		const errorText = await uploadResponse.text();
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, `Failed to deploy worker: ${extractApiError(errorText, uploadResponse.status)}`);
	}
}

/**
 * Enable the workers.dev subdomain route for a deployed worker.
 * By default, new workers have the workers.dev route disabled.
 */
async function enableWorkersDevelopmentSubdomain(accountId: string, apiToken: string, workerName: string): Promise<void> {
	const response = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ enabled: true }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, `Failed to enable workers.dev subdomain: ${extractApiError(errorText, response.status)}`);
	}
}
async function getWorkersDevelopmentUrl(accountId: string, apiToken: string, workerName: string): Promise<string | undefined> {
	try {
		const subdomainResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/subdomain`, {
			headers: { Authorization: `Bearer ${apiToken}` },
		});
		if (subdomainResponse.ok) {
			const data = parseUpstreamResponse(
				workersSubdomainResponseSchema,
				await subdomainResponse.json(),
				'Workers subdomain lookup returned an invalid response',
			);
			if (data.result?.subdomain) {
				return `https://${workerName}.${data.result.subdomain}.workers.dev`;
			}
		}
	} catch {
		// Not critical — just return undefined
	}
	return undefined;
}
function extractApiError(responseBody: string, statusCode: number): string {
	try {
		const parsed: { errors?: Array<{ message: string }> } = JSON.parse(responseBody);
		if (parsed.errors && parsed.errors.length > 0) {
			return parsed.errors.map((error) => error.message).join('; ');
		}
	} catch {
		// Fall through to generic message
	}
	return `API returned status ${statusCode}`;
}

export { extractFrontendEntryPoint, generateProductionHtml, hashFileForManifest, isConfigFile, isSourceFile };

export { sanitizeR2BucketName, sanitizeWorkerName } from '@shared/deploy-helpers';

export type DeployRoutes = typeof deployRoutes;
