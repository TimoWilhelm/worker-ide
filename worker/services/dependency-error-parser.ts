import type { DependencyError } from '@shared/types';

/**
 * Parse dependency errors from an error message string.
 * The Workers runtime re-wraps errors from env.LOADER.get() as plain Error
 * objects, stripping custom properties. This function recovers structured
 * dependency errors by matching the known error message patterns produced
 * by the virtual-fs and esm-cdn plugins.
 */
export function parseDependencyErrorsFromMessage(message: string): DependencyError[] | undefined {
	const errors: DependencyError[] = [];
	const patterns: [RegExp, DependencyError['code']][] = [
		[/Unregistered dependency "([^"]+)"/g, 'unregistered'],
		[/Package not found: "([^"]+)"/g, 'not-found'],
		[/Failed to resolve "([^"]+)" from CDN/g, 'resolve-failed'],
	];
	for (const [pattern, code] of patterns) {
		let match;
		while ((match = pattern.exec(message)) !== null) {
			errors.push({ packageName: match[1], code, message: match[0] });
		}
	}
	return errors.length > 0 ? errors : undefined;
}
