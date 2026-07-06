import { env } from 'cloudflare:workers';
import { Hono } from 'hono';

import {
	ACCEPTED_IMAGE_MEDIA_TYPES,
	IMAGE_MAX_DIMENSION,
	IMAGE_OUTPUT_MEDIA_TYPE,
	IMAGE_OUTPUT_QUALITY,
	MAX_IMAGE_UPLOAD_BYTES,
} from '@shared/constants';
import { HttpErrorCode } from '@shared/http-errors';

import { httpError } from '../lib/http-error';

import type { AppEnvironment } from '../types';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x80_00;
	let binary = '';
	for (let index = 0; index < bytes.length; index += chunkSize) {
		binary += String.fromCodePoint(...bytes.subarray(index, index + chunkSize));
	}
	return btoa(binary);
}

/**
 * Optimize an uploaded image via the Cloudflare Images binding.
 *
 * The raw upload is resized (long-edge capped at IMAGE_MAX_DIMENSION, never
 * upscaled) and transcoded to WebP so only a compact data URL is stored in the
 * agent session, keeping the Durable Object storage small.
 */
export const imageRoutes = new Hono<AppEnvironment>().post('/images/optimize', async (c) => {
	const formData = await c.req.formData();
	const file = formData.get('file');
	if (!(file instanceof File)) {
		throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Expected an image file in the "file" field.');
	}

	if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
		throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Image is too large.', 413);
	}

	if (!ACCEPTED_IMAGE_MEDIA_TYPES.includes(file.type)) {
		throw httpError(HttpErrorCode.VALIDATION_ERROR, `Unsupported image type: ${file.type || 'unknown'}.`);
	}

	let base64: string;
	try {
		const optimized = await env.IMAGES.input(file.stream())
			.transform({ width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION, fit: 'scale-down' })
			.output({ format: 'image/webp', quality: IMAGE_OUTPUT_QUALITY });
		const buffer = await optimized.response().arrayBuffer();
		base64 = arrayBufferToBase64(buffer);
	} catch {
		throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Failed to process image.', 422);
	}

	return c.json({
		url: `data:${IMAGE_OUTPUT_MEDIA_TYPE};base64,${base64}`,
		mediaType: IMAGE_OUTPUT_MEDIA_TYPE,
		name: file.name || undefined,
	});
});
