/**
 * Collects files emitted by plugins via `this.emitFile` (Rollup's emit API).
 *
 * plugin-rsc/vinext emit assets (manifests, client-reference metadata) during
 * the output phase and later read their final names via `this.getFileName`.
 * This sink assigns deterministic reference ids + file names, retains the
 * sources per environment, and lets the build drain them into each
 * environment's output.
 */
import type { EmittedFileSink } from './plugin-container';
import type { EmittedFile, ViteEnvironmentName } from './types';

export interface EmittedAssetRecord {
	referenceId: string;
	fileName: string;
	source: string | Uint8Array;
	environment: ViteEnvironmentName;
}

export class EmittedFiles implements EmittedFileSink {
	private counter = 0;
	private readonly byReference = new Map<string, EmittedAssetRecord>();

	emit(file: EmittedFile, environment: ViteEnvironmentName): string {
		const referenceId = `vite-host-ref-${(this.counter += 1)}`;
		const fileName = this.resolveFileName(file, referenceId);
		if (file.type === 'asset') {
			this.byReference.set(referenceId, { referenceId, fileName, source: file.source, environment });
		} else {
			// Emitted chunks are recorded by name only; the host does not perform a
			// secondary chunk build (the multi-environment build covers entries).
			this.byReference.set(referenceId, { referenceId, fileName, source: '', environment });
		}
		return referenceId;
	}

	getFileName(referenceId: string): string {
		const record = this.byReference.get(referenceId);
		if (record === undefined) {
			throw new Error(`Unknown emitted-file reference: ${referenceId}`);
		}
		return record.fileName;
	}

	/** Emitted assets (with sources) for an environment, for writing to its outDir. */
	assetsFor(environment: ViteEnvironmentName): EmittedAssetRecord[] {
		return [...this.byReference.values()].filter(
			(record) => record.environment === environment && (typeof record.source !== 'string' || record.source.length > 0),
		);
	}

	private resolveFileName(file: EmittedFile, referenceId: string): string {
		if (file.fileName !== undefined) {
			return file.fileName;
		}
		if (file.type === 'asset' && file.name !== undefined) {
			return `assets/${file.name}`;
		}
		if (file.type === 'chunk') {
			return `${file.name ?? file.id}.js`;
		}
		return `assets/${referenceId}`;
	}
}
