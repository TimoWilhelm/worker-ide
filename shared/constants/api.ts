/**
 * API constants for the Worker IDE application.
 */

/**
 * Default headers for JSON API responses
 */
export const JSON_HEADERS = {
	'Content-Type': 'application/json',
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
} as const;
