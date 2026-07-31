import { describe, expect, it } from 'vitest';

import { buildHmrGlue } from './shared';

describe('buildHmrGlue', () => {
	it('sends modules outside the client graph directly to the framework refresh', () => {
		const glue = buildHmrGlue({ softRefreshBody: 'softRefreshFramework();' });

		expect(glue).toContain('if (!runtime.hasModule(id))');
		expect(glue).toContain('softRefresh();');
		expect(glue.indexOf('if (!runtime.hasModule(id))')).toBeLessThan(glue.indexOf('runtime.applyUpdate'));
	});
});
