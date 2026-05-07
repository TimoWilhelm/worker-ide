import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';
import { deployRequestSchema } from '@shared/validation';

import * as schema from '../db/auth-schema';
import { httpError } from '../lib/http-error';
import { readProjectName } from '../lib/protected-files';
import { sanitizeWorkerName } from '../workflows/deploy-helpers';

import type { AppEnvironment } from '../types';
import type { DeployResult, DeployStatusResponse, DeployWorkflowParameters } from '@shared/deploy-types';

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object';
}

function parseDeployResult(value: unknown): DeployResult | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (value.success !== true || typeof value.workerName !== 'string') {
		return undefined;
	}

	return {
		success: true,
		workerName: value.workerName,
		workerUrl: typeof value.workerUrl === 'string' ? value.workerUrl : undefined,
	};
}

export const deployRoutes = new Hono<AppEnvironment>()
	.post('/deploy', zValidator('json', deployRequestSchema), async (c) => {
		const { accountId, apiToken, workerName } = c.req.valid('json');
		const database = drizzle(c.env.DB, { schema });
		const projectRows = await database
			.select({ organizationId: schema.project.organizationId })
			.from(schema.project)
			.where(eq(schema.project.id, c.get('projectId')))
			.limit(1);
		const organizationId = projectRows[0]?.organizationId;
		if (!organizationId) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Project not found');
		}

		const projectName = await readProjectName(c.get('projectRoot'));
		const sanitizedWorkerName = sanitizeWorkerName(workerName || projectName);
		const instanceId = crypto.randomUUID();
		const parameters: DeployWorkflowParameters = {
			accountId: accountId.trim(),
			apiToken: apiToken.trim(),
			workerName: sanitizedWorkerName,
			projectId: c.get('projectId'),
			projectRoot: c.get('projectRoot'),
			organizationId,
			userId: c.get('session').userId,
			requestStartedAt: Date.now(),
		};

		await c.env.DEPLOY_WORKFLOW.create({ id: instanceId, params: parameters });

		return c.json({ instanceId });
	})
	.get('/deploy/status', async (c) => {
		const instanceId = c.req.query('instanceId');
		if (!instanceId) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Missing deployment instance ID');
		}

		const workflowInstance = await c.env.DEPLOY_WORKFLOW.get(instanceId);
		const workflowStatus = await workflowInstance.status();
		return c.json({
			instanceId,
			status: workflowStatus.status,
			result: parseDeployResult(workflowStatus.output),
			error: workflowStatus.error?.message,
		} satisfies DeployStatusResponse);
	});

export {
	extractFrontendEntryPoint,
	generateProductionHtml,
	hashFileForManifest,
	isConfigFile,
	isSourceFile,
	sanitizeR2BucketName,
	sanitizeWorkerName,
} from '../workflows/deploy-helpers';

export type DeployRoutes = typeof deployRoutes;
