export interface UnpackProgress {
	unpacking: boolean;
	processed?: number;
	total?: number;
	percent?: number;
	queuedCount?: number; // 0 or 1 (one-deep queue)
	currentPackKey?: string;
}
