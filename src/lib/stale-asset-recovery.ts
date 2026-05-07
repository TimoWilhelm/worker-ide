const STALE_ASSET_RELOAD_KEY = 'stale-asset-reload';
const STALE_ASSET_RELOAD_WINDOW_MS = 10_000;

const UPDATE_ACTIVATION_RELOAD_KEY = 'update-activation-reload';
const UPDATE_ACTIVATION_RELOAD_WINDOW_MS = 30_000;

const dynamicImportFailurePatterns = [
	/Failed to fetch dynamically imported module/i,
	/Failed to import dynamically imported module/i,
	/Importing a module script failed/i,
	/error loading dynamically imported module/i,
	/Failed to load module script/i,
];

let lastRecoveryTimestamp: number | undefined;
let recoveryListenersInstalled = false;

function isObjectRecord(value: unknown): value is object {
	return typeof value === 'object' && value !== null;
}

function getMessage(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}

	if (value instanceof Error) {
		return value.message;
	}

	if (!isObjectRecord(value)) {
		return undefined;
	}

	const message = Reflect.get(value, 'message');
	if (typeof message === 'string') {
		return message;
	}

	const reason = Reflect.get(value, 'reason');
	if (reason === value) {
		return undefined;
	}

	if (typeof reason === 'string') {
		return reason;
	}

	if (reason instanceof Error) {
		return reason.message;
	}

	if (!isObjectRecord(reason)) {
		return undefined;
	}

	const nestedMessage = Reflect.get(reason, 'message');
	return typeof nestedMessage === 'string' ? nestedMessage : undefined;
}

function readLastRecoveryTimestamp(): number | undefined {
	try {
		const storedValue = globalThis.sessionStorage.getItem(STALE_ASSET_RELOAD_KEY);
		if (!storedValue) {
			return lastRecoveryTimestamp;
		}

		const parsedValue = Number(storedValue);
		return Number.isFinite(parsedValue) ? parsedValue : lastRecoveryTimestamp;
	} catch {
		return lastRecoveryTimestamp;
	}
}

function writeLastRecoveryTimestamp(timestamp: number): void {
	lastRecoveryTimestamp = timestamp;

	try {
		globalThis.sessionStorage.setItem(STALE_ASSET_RELOAD_KEY, String(timestamp));
	} catch {
		return;
	}
}

function readTimestamp(key: string): number | undefined {
	try {
		const storedValue = globalThis.sessionStorage.getItem(key);
		if (!storedValue) {
			return undefined;
		}

		const parsedValue = Number(storedValue);
		return Number.isFinite(parsedValue) ? parsedValue : undefined;
	} catch {
		return undefined;
	}
}

function writeTimestamp(key: string, timestamp: number): void {
	try {
		globalThis.sessionStorage.setItem(key, String(timestamp));
	} catch {
		return;
	}
}

export function markUpdateActivationReloadPending(): void {
	writeTimestamp(UPDATE_ACTIVATION_RELOAD_KEY, Date.now());
}

export function clearUpdateActivationReloadPending(): void {
	try {
		globalThis.sessionStorage.removeItem(UPDATE_ACTIVATION_RELOAD_KEY);
	} catch {
		return;
	}
}

export function isUpdateActivationReloadPending(): boolean {
	const timestamp = readTimestamp(UPDATE_ACTIVATION_RELOAD_KEY);
	if (timestamp === undefined) {
		return false;
	}

	return Date.now() - timestamp < UPDATE_ACTIVATION_RELOAD_WINDOW_MS;
}

export function isDynamicImportFailure(error: unknown): boolean {
	const message = getMessage(error);
	if (!message) {
		return false;
	}

	return dynamicImportFailurePatterns.some((pattern) => pattern.test(message));
}

export function recoverFromStaleAsset(): boolean {
	const now = Date.now();
	const lastAttemptTimestamp = readLastRecoveryTimestamp();
	if (lastAttemptTimestamp !== undefined && now - lastAttemptTimestamp < STALE_ASSET_RELOAD_WINDOW_MS) {
		return false;
	}

	writeLastRecoveryTimestamp(now);
	globalThis.location.reload();
	return true;
}

function handlePreloadError(event: Event): void {
	event.preventDefault();
	recoverFromStaleAsset();
}

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
	if (!isDynamicImportFailure(event.reason)) {
		return;
	}

	event.preventDefault();
	recoverFromStaleAsset();
}

export function installStaleAssetRecovery(): void {
	if (recoveryListenersInstalled) {
		return;
	}

	clearUpdateActivationReloadPending();
	recoveryListenersInstalled = true;
	globalThis.addEventListener('vite:preloadError', handlePreloadError);
	globalThis.addEventListener('unhandledrejection', handleUnhandledRejection);
}
