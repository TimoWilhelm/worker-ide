import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CodeEditor } from './code-editor';

describe('CodeEditor', () => {
	it('does not emit onChange when external value updates replace the document', () => {
		const handleChange = vi.fn();
		const { rerender } = render(<CodeEditor value="const before = true;" filename="/src/main.ts" onChange={handleChange} />);

		rerender(<CodeEditor value="const after = true;" filename="/src/main.ts" onChange={handleChange} />);

		expect(handleChange).not.toHaveBeenCalled();
	});
});
