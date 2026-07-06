/** Maximum number of image attachments allowed on a single agent message. */
export const MAX_IMAGE_ATTACHMENTS = 4;

/** Maximum accepted raw upload size (bytes) before server-side optimization. */
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Longest-edge dimension (px) the optimized image is scaled down to. */
export const IMAGE_MAX_DIMENSION = 1024;

/** Output quality (0-100) for the optimized image. */
export const IMAGE_OUTPUT_QUALITY = 80;

/** Output media type for optimized images. */
export const IMAGE_OUTPUT_MEDIA_TYPE = 'image/webp';

/** Accepted input media types for image attachments. */
export const ACCEPTED_IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
