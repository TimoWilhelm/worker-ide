import { InMemoryFs } from '@cloudflare/shell';
import { describe, expect, it } from 'vitest';

import { formatBashOutput, runBashCommand } from './run-bash';

import type { InitialFiles } from '@cloudflare/shell';

function seed(files: InitialFiles): InMemoryFs {
	return new InMemoryFs(files);
}

describe('runBashCommand', () => {
	it('reads files with cat', async () => {
		const fs = seed({ '/project/greeting.txt': 'hello world\n' });
		const result = await runBashCommand('cat greeting.txt', fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('hello world\n');
	});

	it('runs pipelines (grep | wc -l)', async () => {
		const fs = seed({ '/project/log.txt': 'a TODO here\nnothing\nanother TODO\n' });
		const result = await runBashCommand('grep TODO log.txt | wc -l', fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('2');
	});

	it('processes JSON with jq', async () => {
		const fs = seed({ '/project/data.json': JSON.stringify([{ name: 'Alice' }, { name: 'Bob' }]) });
		const result = await runBashCommand('jq length data.json', fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('2');
	});

	it('persists writes back to the filesystem', async () => {
		const fs = seed({ '/project/.keep': '' });
		const result = await runBashCommand('echo "generated" > out.txt', fs);
		expect(result.exitCode).toBe(0);
		expect(await fs.readFile('/project/out.txt')).toBe('generated\n');
	});

	it('persists deletes back to the filesystem', async () => {
		const fs = seed({ '/project/old.txt': 'stale' });
		const result = await runBashCommand('rm old.txt', fs);
		expect(result.exitCode).toBe(0);
		expect(await fs.exists('/project/old.txt')).toBe(false);
	});

	it('surfaces non-zero exit codes', async () => {
		const fs = seed({ '/project/log.txt': 'nothing here\n' });
		const result = await runBashCommand('grep MISSING log.txt', fs);
		expect(result.exitCode).not.toBe(0);
	});

	it('has no network access (curl is unavailable)', async () => {
		const fs = seed({ '/project/.keep': '' });
		const result = await runBashCommand('curl https://example.com', fs);
		expect(result.exitCode).not.toBe(0);
	});

	it('aborts when the parent signal fires', async () => {
		const fs = seed({ '/project/.keep': '' });
		const controller = new AbortController();
		controller.abort();
		const result = await runBashCommand('echo hi', fs, { abortSignal: controller.signal });
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBe(124);
	});
});

describe('formatBashOutput', () => {
	it('includes stdout and a non-zero exit note', () => {
		const output = formatBashOutput({ stdout: 'out', stderr: 'oops', exitCode: 1, timedOut: false });
		expect(output).toContain('out');
		expect(output).toContain('stderr:');
		expect(output).toContain('Exited with code 1');
	});

	it('reports clean success with just stdout', () => {
		const output = formatBashOutput({ stdout: 'done\n', stderr: '', exitCode: 0, timedOut: false });
		expect(output).toBe('done');
	});
});
