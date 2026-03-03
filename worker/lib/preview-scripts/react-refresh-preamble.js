/**
 * React Fast Refresh Preamble
 *
 * This script MUST be loaded BEFORE React and ReactDOM so that the
 * refresh runtime can intercept the renderer injection via the
 * DevTools global hook.
 *
 * It embeds a self-contained copy of the Vite/React-Refresh runtime
 * (simplified pure-JS version from @vitejs/plugin-react) and exposes:
 *
 *   window.__RefreshRuntime   – the full refresh runtime API
 *   window.$RefreshReg$       – per-module component registration (set to no-op initially)
 *   window.$RefreshSig$       – per-module signature tracking (set to no-op initially)
 *
 * The bundler-service wraps each user module's output so that
 * $RefreshReg$ / $RefreshSig$ point to file-scoped helpers during
 * module evaluation. After the entire bundle executes, the HMR client
 * calls __RefreshRuntime.performReactRefresh() to apply pending updates.
 */
(function () {
	'use strict';

	// =========================================================================
	// Embedded React Refresh Runtime
	// Based on @vitejs/plugin-react/dist/refresh-runtime.js (MIT)
	// Copyright (c) Meta Platforms, Inc. and affiliates.
	// =========================================================================

	var REACT_FORWARD_REF_TYPE = Symbol.for('react.forward_ref');
	var REACT_MEMO_TYPE = Symbol.for('react.memo');

	var allFamiliesByID = new Map();
	var allFamiliesByType = new WeakMap();
	var allSignaturesByType = new WeakMap();
	var updatedFamiliesByType = new WeakMap();
	var pendingUpdates = [];
	var helpersByRendererID = new Map();
	var helpersByRoot = new Map();
	var mountedRoots = new Set();
	var failedRoots = new Set();
	var rootElements = new WeakMap();
	var isPerformingRefresh = false;

	function getProperty(object, property) {
		try {
			return object[property];
		} catch (_) {
			return undefined;
		}
	}

	function computeFullKey(signature) {
		if (signature.fullKey !== null) return signature.fullKey;
		var fullKey = signature.ownKey;
		var hooks;
		try {
			hooks = signature.getCustomHooks();
		} catch (_) {
			signature.forceReset = true;
			signature.fullKey = fullKey;
			return fullKey;
		}
		for (var i = 0; i < hooks.length; i++) {
			var hook = hooks[i];
			if (typeof hook !== 'function') {
				signature.forceReset = true;
				signature.fullKey = fullKey;
				return fullKey;
			}
			var nestedSig = allSignaturesByType.get(hook);
			if (nestedSig === undefined) continue;
			var nestedKey = computeFullKey(nestedSig);
			if (nestedSig.forceReset) signature.forceReset = true;
			fullKey += '\n---\n' + nestedKey;
		}
		signature.fullKey = fullKey;
		return fullKey;
	}

	function haveEqualSignatures(prevType, nextType) {
		var prev = allSignaturesByType.get(prevType);
		var next = allSignaturesByType.get(nextType);
		if (prev === undefined && next === undefined) return true;
		if (prev === undefined || next === undefined) return false;
		if (computeFullKey(prev) !== computeFullKey(next)) return false;
		if (next.forceReset) return false;
		return true;
	}

	function isReactClass(type) {
		return type.prototype && type.prototype.isReactComponent;
	}

	function canPreserveStateBetween(prevType, nextType) {
		if (isReactClass(prevType) || isReactClass(nextType)) return false;
		return haveEqualSignatures(prevType, nextType);
	}

	function resolveFamily(type) {
		return updatedFamiliesByType.get(type);
	}

	function performReactRefresh() {
		if (pendingUpdates.length === 0) return null;
		if (isPerformingRefresh) return null;
		isPerformingRefresh = true;
		try {
			var staleFamilies = new Set();
			var updatedFamilies = new Set();
			var updates = pendingUpdates;
			pendingUpdates = [];
			updates.forEach(function (entry) {
				var family = entry[0];
				var nextType = entry[1];
				var prevType = family.current;
				updatedFamiliesByType.set(prevType, family);
				updatedFamiliesByType.set(nextType, family);
				family.current = nextType;
				if (canPreserveStateBetween(prevType, nextType)) {
					updatedFamilies.add(family);
				} else {
					staleFamilies.add(family);
				}
			});
			var update = { updatedFamilies: updatedFamilies, staleFamilies: staleFamilies };
			helpersByRendererID.forEach(function (helpers) {
				helpers.setRefreshHandler(resolveFamily);
			});
			var didError = false;
			var firstError = null;
			var failedSnapshot = new Set(failedRoots);
			var mountedSnapshot = new Set(mountedRoots);
			var helpersSnapshot = new Map(helpersByRoot);
			failedSnapshot.forEach(function (root) {
				var helpers = helpersSnapshot.get(root);
				if (helpers === undefined) return;
				if (!failedRoots.has(root)) return;
				if (!rootElements.has(root)) return;
				var element = rootElements.get(root);
				try {
					helpers.scheduleRoot(root, element);
				} catch (err) {
					if (!didError) {
						didError = true;
						firstError = err;
					}
				}
			});
			mountedSnapshot.forEach(function (root) {
				var helpers = helpersSnapshot.get(root);
				if (helpers === undefined) return;
				if (!mountedRoots.has(root)) return;
				try {
					helpers.scheduleRefresh(root, update);
				} catch (err) {
					if (!didError) {
						didError = true;
						firstError = err;
					}
				}
			});
			if (didError) throw firstError;
			return update;
		} finally {
			isPerformingRefresh = false;
		}
	}

	function register(type, id) {
		if (type === null) return;
		if (typeof type !== 'function' && typeof type !== 'object') return;
		if (allFamiliesByType.has(type)) return;
		var family = allFamiliesByID.get(id);
		if (family === undefined) {
			family = { current: type };
			allFamiliesByID.set(id, family);
		} else {
			pendingUpdates.push([family, type]);
		}
		allFamiliesByType.set(type, family);
		if (typeof type === 'object' && type !== null) {
			switch (getProperty(type, '$$typeof')) {
				case REACT_FORWARD_REF_TYPE:
					register(type.render, id + '$render');
					break;
				case REACT_MEMO_TYPE:
					register(type.type, id + '$type');
					break;
			}
		}
	}

	function setSignature(type, key, forceReset, getCustomHooks) {
		if (!allSignaturesByType.has(type)) {
			allSignaturesByType.set(type, {
				forceReset: forceReset,
				ownKey: key,
				fullKey: null,
				getCustomHooks:
					getCustomHooks ||
					function () {
						return [];
					},
			});
		}
		if (typeof type === 'object' && type !== null) {
			switch (getProperty(type, '$$typeof')) {
				case REACT_FORWARD_REF_TYPE:
					setSignature(type.render, key, forceReset, getCustomHooks);
					break;
				case REACT_MEMO_TYPE:
					setSignature(type.type, key, forceReset, getCustomHooks);
					break;
			}
		}
	}

	function collectCustomHooksForSignature(type) {
		var signature = allSignaturesByType.get(type);
		if (signature !== undefined) computeFullKey(signature);
	}

	function createSignatureFunctionForTransform() {
		var savedType;
		var hasCustomHooks;
		var didCollectHooks = false;
		return function (type, key, forceReset, getCustomHooks) {
			if (typeof key === 'string') {
				if (!savedType) {
					savedType = type;
					hasCustomHooks = typeof getCustomHooks === 'function';
				}
				if (type != null && (typeof type === 'function' || typeof type === 'object')) {
					setSignature(type, key, forceReset, getCustomHooks);
				}
				return type;
			} else {
				if (!didCollectHooks && hasCustomHooks) {
					didCollectHooks = true;
					collectCustomHooksForSignature(savedType);
				}
			}
		};
	}

	function isLikelyComponentType(type) {
		switch (typeof type) {
			case 'function': {
				if (type.prototype != null) {
					if (type.prototype.isReactComponent) return true;
					var ownNames = Object.getOwnPropertyNames(type.prototype);
					if (ownNames.length > 1 || ownNames[0] !== 'constructor') return false;
					if (type.prototype.__proto__ !== Object.prototype) return false;
				}
				var name = type.name || type.displayName;
				return typeof name === 'string' && /^[A-Z]/.test(name);
			}
			case 'object': {
				if (type != null) {
					switch (getProperty(type, '$$typeof')) {
						case REACT_FORWARD_REF_TYPE:
						case REACT_MEMO_TYPE:
							return true;
						default:
							return false;
					}
				}
				return false;
			}
			default:
				return false;
		}
	}

	function injectIntoGlobalHook(globalObject) {
		var hook = globalObject.__REACT_DEVTOOLS_GLOBAL_HOOK__;
		if (hook === undefined) {
			var nextID = 0;
			globalObject.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook = {
				renderers: new Map(),
				supportsFiber: true,
				inject: function () {
					return nextID++;
				},
				onScheduleFiberRoot: function () {},
				onCommitFiberRoot: function () {},
				onCommitFiberUnmount: function () {},
			};
		}
		if (hook.isDisabled) return;

		var oldInject = hook.inject;
		hook.inject = function (injected) {
			var id = oldInject.apply(this, arguments);
			if (typeof injected.scheduleRefresh === 'function' && typeof injected.setRefreshHandler === 'function') {
				helpersByRendererID.set(id, injected);
			}
			return id;
		};
		hook.renderers.forEach(function (injected, id) {
			if (typeof injected.scheduleRefresh === 'function' && typeof injected.setRefreshHandler === 'function') {
				helpersByRendererID.set(id, injected);
			}
		});

		var oldOnCommitFiberRoot = hook.onCommitFiberRoot;
		var oldOnScheduleFiberRoot = hook.onScheduleFiberRoot || function () {};
		hook.onScheduleFiberRoot = function (id, root, children) {
			if (!isPerformingRefresh) {
				failedRoots.delete(root);
				if (rootElements !== null) rootElements.set(root, children);
			}
			return oldOnScheduleFiberRoot.apply(this, arguments);
		};
		hook.onCommitFiberRoot = function (id, root, maybePriorityLevel, didError) {
			var helpers = helpersByRendererID.get(id);
			if (helpers !== undefined) {
				helpersByRoot.set(root, helpers);
				var current = root.current;
				var alternate = current.alternate;
				if (alternate !== null) {
					var wasMounted = alternate.memoizedState != null && alternate.memoizedState.element != null && mountedRoots.has(root);
					var isMounted = current.memoizedState != null && current.memoizedState.element != null;
					if (!wasMounted && isMounted) {
						mountedRoots.add(root);
						failedRoots.delete(root);
					} else if (wasMounted && !isMounted) {
						mountedRoots.delete(root);
						if (didError) failedRoots.add(root);
						else helpersByRoot.delete(root);
					} else if (!wasMounted && !isMounted) {
						if (didError) failedRoots.add(root);
					}
				} else {
					mountedRoots.add(root);
				}
			}
			return oldOnCommitFiberRoot.apply(this, arguments);
		};
	}

	// Utility: register all exports of a module for React Refresh
	function registerExportsForReactRefresh(filename, moduleExports) {
		for (var key in moduleExports) {
			if (key === '__esModule') continue;
			var exportValue = moduleExports[key];
			if (isLikelyComponentType(exportValue)) {
				register(exportValue, filename + ' export ' + key);
			}
		}
	}

	// =========================================================================
	// Expose the runtime globally
	// =========================================================================

	var runtime = {
		register: register,
		setSignature: setSignature,
		collectCustomHooksForSignature: collectCustomHooksForSignature,
		createSignatureFunctionForTransform: createSignatureFunctionForTransform,
		performReactRefresh: performReactRefresh,
		injectIntoGlobalHook: injectIntoGlobalHook,
		isLikelyComponentType: isLikelyComponentType,
		registerExportsForReactRefresh: registerExportsForReactRefresh,
	};

	// Inject into global hook IMMEDIATELY — this must happen before React loads
	runtime.injectIntoGlobalHook(window);

	// Expose the runtime for the HMR client and bundler-injected wrappers
	window.__RefreshRuntime = runtime;

	// Set up no-op globals that the bundler-injected per-module wrappers will override.
	// These must exist before any bundle code executes.
	window.$RefreshReg$ = function () {};
	window.$RefreshSig$ = function () {
		return function (type) {
			return type;
		};
	};
})();
