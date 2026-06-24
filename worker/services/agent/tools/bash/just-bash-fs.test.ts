import { InMemoryFs } from '@cloudflare/shell';
import { describe, expect, it } from 'vitest';

import { JustBashFs } from './just-bash-fs';

describe('JustBashFs', () => {
	it('converts shell stat into just-bash boolean flags', async () => {
		const fs = new JustBashFs(new InMemoryFs({ '/file.txt': 'hi', '/dir/.keep': '' }));

		const fileStat = await fs.stat('/file.txt');
		expect(fileStat.isFile).toBe(true);
		expect(fileStat.isDirectory).toBe(false);
		expect(fileStat.size).toBe(2);

		const directoryStat = await fs.stat('/dir');
		expect(directoryStat.isDirectory).toBe(true);
		expect(directoryStat.isFile).toBe(false);
	});

	it('maps readdirWithFileTypes entry types to flags', async () => {
		const fs = new JustBashFs(new InMemoryFs({ '/root/a.txt': 'a', '/root/sub/.keep': '' }));
		const entries = await fs.readdirWithFileTypes('/root');
		const byName = new Map(entries.map((entry) => [entry.name, entry]));
		expect(byName.get('a.txt')?.isFile).toBe(true);
		expect(byName.get('sub')?.isDirectory).toBe(true);
	});

	it('round-trips binary content via readFileBuffer/writeFile', async () => {
		const fs = new JustBashFs(new InMemoryFs({}));
		const bytes = new Uint8Array([0, 1, 2, 255]);
		await fs.writeFile('/bin', bytes);
		expect([...(await fs.readFileBuffer('/bin'))]).toEqual([...bytes]);
	});

	it('treats chmod and utimes as no-ops', async () => {
		const fs = new JustBashFs(new InMemoryFs({ '/file.txt': 'hi' }));
		await expect(fs.chmod('/file.txt', 0o755)).resolves.toBeUndefined();
		await expect(fs.utimes('/file.txt', new Date(), new Date())).resolves.toBeUndefined();
	});

	it('returns an empty flat path index', () => {
		const fs = new JustBashFs(new InMemoryFs({ '/file.txt': 'hi' }));
		expect(fs.getAllPaths()).toEqual([]);
	});

	it('rejects hard links as unsupported', async () => {
		const fs = new JustBashFs(new InMemoryFs({ '/file.txt': 'hi' }));
		await expect(fs.link('/file.txt', '/link.txt')).rejects.toThrow(/ENOSYS/);
	});
});
