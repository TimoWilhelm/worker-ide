/**
 * Transparent retry proxy for Durable Objects.
 *
 * Wraps a DurableObjectNamespace to automatically retry failed RPC calls
 * with exponential backoff and jitter. Creates a fresh stub on each retry
 * since exceptions can leave stubs in a "broken" state.
 *
 * IMPORTANT — workerd illegal-invocation constraint:
 * workerd uses C++-backed proxy objects for namespaces and stubs. Extracting a
 * method into a variable (via Reflect.get, destructuring, or assignment) detaches
 * the internal `this` binding and throws "Illegal invocation" when called.
 * The ONLY safe pattern is a single expression where property access and call
 * happen together: `obj[key](...args)`.  Never `const fn = obj[key]; fn(...)`.
 *
 * @see https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 * @see https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors
 */

export interface RetryOptions {
	/** Maximum number of retry attempts (default: 3) */
	maxAttempts?: number;
	/** Base delay in milliseconds for exponential backoff (default: 100) */
	baseDelayMs?: number;
	/** Maximum delay in milliseconds (default: 3000) */
	maxDelayMs?: number;
	/** Custom function to determine if an error is retryable */
	isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'isRetryable'>> = {
	maxAttempts: 3,
	baseDelayMs: 100,
	maxDelayMs: 3000,
};

/**
 * Type guard for objects that may have retryable/overloaded properties
 * set by the Durable Objects runtime.
 */
function isObjectWithProperties(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Returns true if the error is retryable according to Durable Object error handling best practices.
 * - `.retryable` must be true
 * - `.overloaded` must NOT be true (retrying would worsen the overload)
 */
function isErrorRetryable(error: unknown): boolean {
	if (!isObjectWithProperties(error)) {
		return false;
	}
	const message = String(error);
	return Boolean(error.retryable) && !error.overloaded && !message.includes('Durable Object is overloaded');
}

/**
 * Calculates jittered exponential backoff delay.
 * Uses the "Full Jitter" approach from AWS.
 * @see https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
function jitterBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
	const attemptUpperBoundMs = Math.min(2 ** attempt * baseDelayMs, maxDelayMs);
	return Math.floor(Math.random() * attemptUpperBoundMs);
}

/**
 * Invoke a method on a workerd proxy object by property name in a single expression.
 * This preserves the internal `this` binding that workerd requires.
 * The property access and call MUST happen on the same object reference in one
 * expression — storing the method in a variable first causes "Illegal invocation".
 */
function callMethod(object: object, property: string | symbol, arguments_: unknown[]): unknown {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Required: workerd proxy objects need bracket-notation property access + call in a single expression to preserve the C++ `this` binding.
	return (object as Record<string | symbol, (...a: unknown[]) => unknown>)[property](...arguments_);
}

type StubGetter<T extends Rpc.DurableObjectBranded> = () => DurableObjectStub<T>;

type ResolvedOptions = Required<Omit<RetryOptions, 'isRetryable'>> & {
	isRetryable?: (error: unknown) => boolean;
};

/** Non-function properties on DurableObjectStub read directly (no wrapping). */
const STUB_VALUE_PROPERTIES = new Set(['id', 'name']);

/**
 * Creates a proxy around a DurableObjectStub that retries failed RPC calls.
 * On each retry, a fresh stub is obtained via the getter function.
 */
function createStubProxy<T extends Rpc.DurableObjectBranded>(getStub: StubGetter<T>, options: ResolvedOptions): DurableObjectStub<T> {
	const stub = getStub();

	return new Proxy(stub, {
		get(target, property) {
			// Pass through symbol-keyed properties (e.g. Symbol.toPrimitive, Symbol.toStringTag)
			if (typeof property === 'symbol') {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Reading a symbol property from workerd proxy via bracket notation.
				return (target as unknown as Record<symbol, unknown>)[property];
			}

			// Pass through non-function value properties directly.
			if (STUB_VALUE_PROPERTIES.has(property)) {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Reading a non-function property from workerd proxy via bracket notation.
				return (target as Record<string, unknown>)[property];
			}

			// Don't wrap .fetch() — it's used for WebSocket upgrades and HTTP
			// forwarding where retry semantics are inappropriate. Return a wrapper
			// that preserves `this` by calling through the target inline.
			if (property === 'fetch') {
				return (...arguments_: unknown[]) => callMethod(target, property, arguments_);
			}

			// Wrap everything else as a retryable RPC call.
			return async (...arguments_: unknown[]) => {
				let attempt = 1;

				while (attempt <= options.maxAttempts) {
					try {
						// Get a fresh stub for each retry attempt (critical for broken stub recovery).
						// On the first attempt use the original target; on retries create a new one.
						const currentStub = attempt === 1 ? target : getStub();
						return await callMethod(currentStub, property, arguments_);
					} catch (error) {
						// Check if we should retry:
						// 1. Always retry infrastructure errors (unless overloaded)
						// 2. Check custom predicate if provided
						if (!isErrorRetryable(error) && !options.isRetryable?.(error)) {
							throw error;
						}

						// Check if we've exhausted attempts
						if (attempt >= options.maxAttempts) {
							throw error;
						}

						// Calculate backoff and wait
						const delay = jitterBackoff(attempt, options.baseDelayMs, options.maxDelayMs);
						await scheduler.wait(delay);

						attempt++;
					}
				}
			};
		},
	});
}

/**
 * Wraps a DurableObjectNamespace with automatic retry capabilities.
 *
 * The returned namespace is fully transparent — use it exactly like the original.
 * All RPC method calls on stubs obtained from this namespace will automatically
 * retry on transient failures with exponential backoff.
 *
 * @example
 * ```ts
 * const namespace = withRetry(exports.MyDurableObject);
 * const stub = namespace.get(id);
 * const result = await stub.someMethod(); // Automatically retries on failure
 * ```
 */
export function withRetry<T extends Rpc.DurableObjectBranded>(
	namespace: DurableObjectNamespace<T>,
	options?: RetryOptions,
): DurableObjectNamespace<T> {
	const resolvedOptions: ResolvedOptions = {
		...DEFAULT_OPTIONS,
		...options,
		maxAttempts: Math.max(1, options?.maxAttempts ?? DEFAULT_OPTIONS.maxAttempts),
	};

	return new Proxy(namespace, {
		get(target, property) {
			// Pass through non-string properties via inline call to preserve `this`.
			if (typeof property !== 'string') {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Reading a symbol property from workerd proxy via bracket notation.
				return (target as unknown as Record<symbol, unknown>)[property];
			}

			// Intercept .get() — returns a retry-wrapped stub
			if (property === 'get') {
				return (id: DurableObjectId) => {
					const getStub = () => target.get(id);
					return createStubProxy(getStub, resolvedOptions);
				};
			}

			// Intercept .getByName() — convenience method that creates stub by name
			if (property === 'getByName') {
				return (name: string, getOptions?: DurableObjectGetOptions) => {
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- getByName exists at runtime but not in TS type; must use bracket-notation call in single expression.
					const getStub = () => callMethod(target, 'getByName', getOptions ? [name, getOptions] : [name]) as DurableObjectStub<T>;
					return createStubProxy(getStub, resolvedOptions);
				};
			}

			// Intercept .jurisdiction() — returns a retry-wrapped sub-namespace
			if (property === 'jurisdiction') {
				return (jurisdiction: DurableObjectJurisdiction) => {
					const jurisdictionNamespace = target.jurisdiction(jurisdiction);
					return withRetry(jurisdictionNamespace, options);
				};
			}

			// For all other properties (idFromName, idFromString, newUniqueId, etc.)
			// return a wrapper that calls through to the target inline to preserve `this`.
			return (...arguments_: unknown[]) => callMethod(target, property, arguments_);
		},
	});
}
