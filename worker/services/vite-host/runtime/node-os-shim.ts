/**
 * Benign `node:os` shim for the Vite Surface Host runtime.
 *
 * vinext calls `os.platform()`, `os.cpus()`, etc. at import time (for parallelism
 * heuristics and path handling). workerd's `node:os` is incomplete, so we provide
 * stable, sensible values. These influence only build heuristics, never output.
 */
export function platform(): string {
	return 'linux';
}

export function type(): string {
	return 'Linux';
}

export function release(): string {
	return '0.0.0';
}

export function arch(): string {
	return 'x64';
}

export function cpus(): Array<{ model: string; speed: number }> {
	return [{ model: 'workerd', speed: 0 }];
}

export function availableParallelism(): number {
	return 1;
}

export function loadavg(): number[] {
	return [0, 0, 0];
}

export function endianness(): string {
	return 'LE';
}

export function totalmem(): number {
	return 0;
}

export function freemem(): number {
	return 0;
}

export function homedir(): string {
	return '/';
}

export function tmpdir(): string {
	return '/tmp';
}

export function hostname(): string {
	return 'workerd';
}

export const EOL = '\n';

export default {
	platform,
	type,
	release,
	arch,
	cpus,
	availableParallelism,
	loadavg,
	endianness,
	totalmem,
	freemem,
	homedir,
	tmpdir,
	hostname,
	EOL,
};
