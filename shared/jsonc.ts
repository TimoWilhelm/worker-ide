import { parse, printParseErrorCode } from 'jsonc-parser';

import type { ParseError } from 'jsonc-parser';

export function parseJsonc<T = unknown>(text: string): T {
	const parseErrors: ParseError[] = [];
	const parsedValue = parse(text, parseErrors, {
		allowTrailingComma: true,
		disallowComments: false,
		allowEmptyContent: false,
	});

	if (parseErrors.length > 0) {
		const firstError = parseErrors[0];
		throw new Error(`Failed to parse JSONC at offset ${firstError.offset}: ${printParseErrorCode(firstError.error)}`);
	}

	return parsedValue;
}
