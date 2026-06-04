/**
 * Preview Runtime
 *
 * Owns the preview module graph and all hot-update behavior in the browser.
 * The websocket client only delivers update payloads to this runtime.
 */
(function () {
	function normalizeModuleId(moduleId) {
		var url = new URL(String(moduleId), location.origin);
		url.hash = '';
		url.searchParams.delete('t');
		var search = url.searchParams.toString();
		return url.pathname + (search ? '?' + search : '');
	}

	function toHotImportUrl(moduleId, timestamp) {
		var url = new URL(normalizeModuleId(moduleId), location.origin);
		url.searchParams.set('t', String(timestamp));
		var search = url.searchParams.toString();
		return url.pathname + (search ? '?' + search : '');
	}

	function resolveAcceptedDependencyId(importerId, dependencyId) {
		return normalizeModuleId(new URL(String(dependencyId), new URL(normalizeModuleId(importerId), location.origin)).href);
	}

	function importPreviewModule(moduleId, timestamp) {
		var importUrl = toHotImportUrl(moduleId, timestamp);
		if (typeof window.__PREVIEW_RUNTIME_IMPORT__ === 'function') {
			return window.__PREVIEW_RUNTIME_IMPORT__(normalizeModuleId(moduleId), importUrl);
		}
		return import(importUrl);
	}

	function reloadPreview() {
		emitEvent('vite:beforeFullReload', { type: 'full-reload' });
		if (typeof window.__PREVIEW_RUNTIME_RELOAD__ === 'function') {
			window.__PREVIEW_RUNTIME_RELOAD__();
			return;
		}
		location.reload();
	}

	// =====================================================================
	// HMR event bus (mirrors Vite's import.meta.hot.on/off/send + built-in
	// events). Listeners registered via hot.on are aggregated here and tracked
	// per module record so they can be removed on dispose/prune.
	// =====================================================================
	var eventListeners = new Map();

	function addEventListenerEntry(event, callback) {
		var listeners = eventListeners.get(event);
		if (!listeners) {
			listeners = new Set();
			eventListeners.set(event, listeners);
		}
		listeners.add(callback);
	}

	function removeEventListenerEntry(event, callback) {
		var listeners = eventListeners.get(event);
		if (!listeners) {
			return;
		}
		listeners.delete(callback);
		if (listeners.size === 0) {
			eventListeners.delete(event);
		}
	}

	function emitEvent(event, payload) {
		var listeners = eventListeners.get(event);
		if (!listeners) {
			return;
		}
		for (var callback of Array.from(listeners)) {
			try {
				callback(payload);
			} catch (error) {
				console.error('[preview-hmr] event listener for "' + event + '" failed', error);
			}
		}
	}

	// Update/invalidation coordination state.
	var activeUpdateTimestamp = 0;
	var isApplyingUpdate = false;
	var pendingInvalidations = [];

	var moduleRecords = new Map();

	function ensureModuleRecord(moduleId) {
		var normalizedModuleId = normalizeModuleId(moduleId);
		var existingRecord = moduleRecords.get(normalizedModuleId);
		if (existingRecord) {
			return existingRecord;
		}

		var record = {
			id: normalizedModuleId,
			imports: new Set(),
			importers: new Set(),
			disposeHandlers: [],
			pruneHandlers: [],
			dependencyAcceptances: [],
			customListeners: [],
			selfAccept: false,
			selfAcceptCallback: undefined,
			data: {},
		};
		moduleRecords.set(normalizedModuleId, record);
		return record;
	}

	function registerModule(moduleId, importedModuleIds) {
		var record = ensureModuleRecord(moduleId);

		var previousImports = record.imports;
		var nextImports = new Set();
		for (var i = 0; i < importedModuleIds.length; i++) {
			var importedModuleId = normalizeModuleId(importedModuleIds[i]);
			if (importedModuleId !== record.id) {
				nextImports.add(importedModuleId);
			}
		}

		for (var previousImportId of previousImports) {
			var previousDependency = moduleRecords.get(previousImportId);
			if (previousDependency) {
				previousDependency.importers.delete(record.id);
			}
		}

		record.imports = new Set();
		for (var nextImportId of nextImports) {
			record.imports.add(nextImportId);
			ensureModuleRecord(nextImportId).importers.add(record.id);
		}

		// Prune dependencies that are no longer imported by anyone. Entry
		// modules (referenced from HTML) are never part of an importer's
		// import list, so they are never pruned by this logic.
		for (var removedImportId of previousImports) {
			if (nextImports.has(removedImportId)) {
				continue;
			}
			var removedDependency = moduleRecords.get(removedImportId);
			if (removedDependency && removedDependency.importers.size === 0) {
				pruneModule(removedImportId);
			}
		}
	}

	function removeRecordListeners(record) {
		for (var index = 0; index < record.customListeners.length; index++) {
			removeEventListenerEntry(record.customListeners[index].event, record.customListeners[index].callback);
		}
		record.customListeners = [];
	}

	function clearHotState(record) {
		removeRecordListeners(record);
		record.disposeHandlers = [];
		record.pruneHandlers = [];
		record.dependencyAcceptances = [];
		record.selfAccept = false;
		record.selfAcceptCallback = undefined;
	}

	function callPruneHandlers(record) {
		var pruneHandlers = record.pruneHandlers.slice();
		for (var index = 0; index < pruneHandlers.length; index++) {
			try {
				pruneHandlers[index](record.data);
			} catch (error) {
				console.error('[preview-hmr] prune handler failed', error);
			}
		}
	}

	function removeStyle(moduleId) {
		var normalizedModuleId = normalizeModuleId(moduleId);
		var style = document.querySelector('style[data-preview-id="' + normalizedModuleId + '"]');
		if (style && style.parentNode) {
			style.parentNode.removeChild(style);
		}
	}

	function pruneModule(moduleId) {
		var record = moduleRecords.get(moduleId);
		if (!record) {
			return;
		}

		emitEvent('vite:beforePrune', { type: 'prune', moduleId: moduleId });

		var orphanedImports = Array.from(record.imports);

		callPruneHandlers(record);
		removeStyle(moduleId);
		removeRecordListeners(record);

		for (var importId of orphanedImports) {
			var dependency = moduleRecords.get(importId);
			if (dependency) {
				dependency.importers.delete(moduleId);
			}
		}

		moduleRecords.delete(moduleId);

		for (var orphanId of orphanedImports) {
			var dependencyRecord = moduleRecords.get(orphanId);
			if (dependencyRecord && dependencyRecord.importers.size === 0) {
				pruneModule(orphanId);
			}
		}
	}

	function createHotContext(moduleId) {
		var record = ensureModuleRecord(moduleId);

		return {
			get data() {
				return record.data;
			},
			accept: function (dependenciesOrCallback, callback) {
				if (dependenciesOrCallback === undefined) {
					record.selfAccept = true;
					return;
				}

				if (typeof dependenciesOrCallback === 'function') {
					record.selfAccept = true;
					record.selfAcceptCallback = dependenciesOrCallback;
					return;
				}

				var dependencies = Array.isArray(dependenciesOrCallback) ? dependenciesOrCallback : [dependenciesOrCallback];
				record.dependencyAcceptances.push({
					dependencies: dependencies.map(function (dependencyId) {
						return resolveAcceptedDependencyId(record.id, dependencyId);
					}),
					callback: typeof callback === 'function' ? callback : undefined,
					rerunBoundary: typeof callback !== 'function',
				});
			},
			acceptExports: function (_exportNames, callback) {
				// True export-level granularity requires diffing module exports,
				// which is not available here. Treat as a self-accepting boundary
				// with an optional callback receiving the new module namespace.
				record.selfAccept = true;
				if (typeof callback === 'function') {
					record.selfAcceptCallback = callback;
				}
			},
			dispose: function (callback) {
				if (typeof callback === 'function') {
					record.disposeHandlers.push(callback);
				}
			},
			prune: function (callback) {
				if (typeof callback === 'function') {
					record.pruneHandlers.push(callback);
				}
			},
			// Deprecated in Vite; kept as a no-op for compatibility.
			decline: function () {},
			invalidate: function (message) {
				queueInvalidation(record.id, message);
			},
			on: function (event, callback) {
				if (typeof callback !== 'function') {
					return;
				}
				record.customListeners.push({ event: event, callback: callback });
				addEventListenerEntry(event, callback);
			},
			off: function (event, callback) {
				for (var index = record.customListeners.length - 1; index >= 0; index--) {
					if (record.customListeners[index].event === event && record.customListeners[index].callback === callback) {
						record.customListeners.splice(index, 1);
					}
				}
				removeEventListenerEntry(event, callback);
			},
			send: function (event, data) {
				if (typeof window.__PREVIEW_RUNTIME_SEND__ === 'function') {
					window.__PREVIEW_RUNTIME_SEND__(event, data);
				}
			},
		};
	}

	function upsertStyle(moduleId, cssText) {
		var normalizedModuleId = normalizeModuleId(moduleId);
		var style = document.querySelector('style[data-preview-id="' + normalizedModuleId + '"]');
		if (!style) {
			style = document.createElement('style');
			style.setAttribute('data-preview-id', normalizedModuleId);
			document.head.appendChild(style);
		}
		style.textContent = cssText;
		return style;
	}

	function updateLinkedStylesheet(resourceId, timestamp) {
		var normalizedResourceId = normalizeModuleId(resourceId);
		var links = document.querySelectorAll('link[rel="stylesheet"][data-preview-id]');
		for (var i = 0; i < links.length; i++) {
			if (normalizeModuleId(links[i].getAttribute('data-preview-id') || '') !== normalizedResourceId) {
				continue;
			}
			links[i].setAttribute('href', toHotImportUrl(normalizedResourceId, timestamp));
		}
	}

	function collectBoundaryPlans(changedModuleId, ignoreSelfAcceptIds) {
		var normalizedModuleId = normalizeModuleId(changedModuleId);
		var plans = [];
		var queue = [normalizedModuleId];
		var visited = new Set();
		var shouldReload = false;
		var touchedGraph = false;

		while (queue.length > 0) {
			var currentModuleId = queue.shift();
			if (currentModuleId === undefined || visited.has(currentModuleId)) {
				continue;
			}
			visited.add(currentModuleId);

			var record = moduleRecords.get(currentModuleId);
			if (!record) {
				continue;
			}
			touchedGraph = true;

			if (record.selfAccept && !(ignoreSelfAcceptIds && ignoreSelfAcceptIds.has(currentModuleId))) {
				plans.push({ kind: 'self', boundaryId: currentModuleId });
				continue;
			}

			if (record.importers.size === 0) {
				shouldReload = true;
				continue;
			}

			for (var importerId of record.importers) {
				var importerRecord = moduleRecords.get(importerId);
				if (!importerRecord) {
					continue;
				}
				var importerAcceptedCurrent = false;

				for (var index = 0; index < importerRecord.dependencyAcceptances.length; index++) {
					var acceptance = importerRecord.dependencyAcceptances[index];
					if (!acceptance.dependencies.includes(currentModuleId)) {
						continue;
					}
					importerAcceptedCurrent = true;
					if (acceptance.rerunBoundary) {
						plans.push({ kind: 'rerun', boundaryId: importerId });
					} else {
						plans.push({ kind: 'deps', boundaryId: importerId, acceptanceIndex: index });
					}
				}

				if (!importerAcceptedCurrent) {
					queue.push(importerId);
				}
			}
		}

		return {
			plans: plans,
			shouldReload: shouldReload,
			touchedGraph: touchedGraph,
		};
	}

	function callDisposeHandlers(record) {
		var disposeHandlers = record.disposeHandlers.slice();
		clearHotState(record);
		for (var index = 0; index < disposeHandlers.length; index++) {
			disposeHandlers[index](record.data);
		}
	}

	async function reloadBoundaryModule(boundaryId, timestamp) {
		var record = ensureModuleRecord(boundaryId);
		callDisposeHandlers(record);
		var moduleNamespace = await importPreviewModule(boundaryId, timestamp);
		if (window.__RefreshRuntime) {
			window.__RefreshRuntime.performReactRefresh();
		}
		var refreshedRecord = ensureModuleRecord(boundaryId);
		if (typeof refreshedRecord.selfAcceptCallback === 'function') {
			refreshedRecord.selfAcceptCallback(moduleNamespace);
		}
	}

	async function applyDependencyAcceptance(boundaryId, acceptanceIndex, timestamp) {
		var record = moduleRecords.get(boundaryId);
		if (!record) {
			return;
		}
		var acceptance = record.dependencyAcceptances[acceptanceIndex];
		if (!acceptance || typeof acceptance.callback !== 'function') {
			return;
		}

		var modules = await Promise.all(
			acceptance.dependencies.map(function (dependencyId) {
				callDisposeHandlers(ensureModuleRecord(dependencyId));
				return importPreviewModule(dependencyId, timestamp);
			}),
		);
		acceptance.callback(Array.isArray(modules) && modules.length === 1 ? modules[0] : modules);
		if (window.__RefreshRuntime) {
			window.__RefreshRuntime.performReactRefresh();
		}
	}

	async function applyBoundaryPlans(plans, timestamp) {
		var dedupedPlans = new Map();
		for (var index = 0; index < plans.length; index++) {
			var boundaryPlan = plans[index];
			var planKey = boundaryPlan.kind + ':' + boundaryPlan.boundaryId + ':' + String(boundaryPlan.acceptanceIndex || '');
			if (!dedupedPlans.has(planKey)) {
				dedupedPlans.set(planKey, boundaryPlan);
			}
		}

		for (var dedupedPlan of dedupedPlans.values()) {
			if (dedupedPlan.kind === 'deps') {
				await applyDependencyAcceptance(dedupedPlan.boundaryId, dedupedPlan.acceptanceIndex, timestamp);
			} else {
				await reloadBoundaryModule(dedupedPlan.boundaryId, timestamp);
			}
		}
	}

	async function applyModuleUpdate(moduleId, timestamp) {
		var plan = collectBoundaryPlans(moduleId);
		if (!plan.touchedGraph) {
			console.debug('[preview-hmr] changed module not in running graph; reloading preview', normalizeModuleId(moduleId));
			reloadPreview();
			return;
		}
		if (plan.shouldReload) {
			reloadPreview();
			return;
		}

		await applyBoundaryPlans(plan.plans, timestamp);
	}

	// Mirrors Vite's invalidate semantics: a self-accepting boundary that
	// cannot actually handle the update bubbles the change to its importers.
	// If it reaches a root module with no importers, a full reload occurs.
	function queueInvalidation(moduleId, message) {
		var normalizedModuleId = normalizeModuleId(moduleId);
		emitEvent('vite:invalidate', { path: normalizedModuleId, message: message });
		console.debug('[preview-hmr] invalidate', normalizedModuleId, message || '');
		if (isApplyingUpdate) {
			pendingInvalidations.push(normalizedModuleId);
			return;
		}
		void runInvalidation(normalizedModuleId);
	}

	async function runInvalidation(moduleId) {
		var plan = collectBoundaryPlans(moduleId, new Set([moduleId]));
		if (!plan.touchedGraph || plan.shouldReload) {
			reloadPreview();
			return;
		}
		await applyBoundaryPlans(plan.plans, activeUpdateTimestamp || Date.now());
	}

	async function drainInvalidations() {
		while (pendingInvalidations.length > 0) {
			var moduleId = pendingInvalidations.shift();
			await runInvalidation(moduleId);
		}
	}

	async function applyUpdate(update) {
		activeUpdateTimestamp = update.timestamp;
		isApplyingUpdate = true;
		emitEvent('vite:beforeUpdate', update);
		try {
			await applyUpdateTargets(update);
		} finally {
			isApplyingUpdate = false;
		}
		await drainInvalidations();
		emitEvent('vite:afterUpdate', update);
	}

	async function applyUpdateTargets(update) {
		for (var index = 0; index < update.targets.length; index++) {
			var target = update.targets[index];
			if (target.kind === 'style-link') {
				updateLinkedStylesheet(target.id, update.timestamp);
			} else if (target.kind === 'module') {
				await applyModuleUpdate(target.id, update.timestamp);
			}
		}
	}

	window.__PREVIEW_RUNTIME__ = {
		applyUpdate: applyUpdate,
		createHotContext: createHotContext,
		normalizeModuleId: normalizeModuleId,
		registerModule: registerModule,
		upsertStyle: upsertStyle,
		// Dispatch an event on the HMR bus (used by the transport client for
		// vite:ws:connect / vite:ws:disconnect / vite:error and server-pushed
		// custom events).
		emitEvent: emitEvent,
	};
})();
