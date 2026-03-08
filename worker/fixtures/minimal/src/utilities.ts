/**
 * Utility functions for the Minimal template.
 */

/**
 * Return a greeting string for the given name.
 */
export function greet(name: string): string {
	return `Hello, ${name}!`;
}

/**
 * Capitalize the first letter of a string.
 */
export function capitalize(value: string): string {
	if (value.length === 0) return value;
	return value.charAt(0).toUpperCase() + value.slice(1);
}
