/**
 * Create a single-flight runner that executes async tasks one at a time, in
 * submission order. Each task starts only after the previous one settles, so
 * tasks that share process-global state (e.g. an in-worker build that installs
 * global services) never interleave. A rejected task does not break the queue.
 */
export function createSerialRunner(): <T>(task: () => Promise<T>) => Promise<T> {
	let chain: Promise<unknown> = Promise.resolve();
	return <T>(task: () => Promise<T>): Promise<T> => {
		const result = chain.then(task, task);
		chain = result.then(
			() => {},
			() => {},
		);
		return result;
	};
}
