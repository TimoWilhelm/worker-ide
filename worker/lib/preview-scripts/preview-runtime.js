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
		if (typeof window.__PREVIEW_RUNTIME_RELOAD__ === 'function') {
			window.__PREVIEW_RUNTIME_RELOAD__();
			return;
		}
		location.reload();
	}

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
			dependencyAcceptances: [],
			selfAccept: false,
			selfAcceptCallback: undefined,
			data: {},
		};
		moduleRecords.set(normalizedModuleId, record);
		return record;
	}

	function registerModule(moduleId, importedModuleIds) {
		var record = ensureModuleRecord(moduleId);
		for (var oldImportId of record.imports) {
			var oldDependencyRecord = moduleRecords.get(oldImportId);
			if (oldDependencyRecord) {
				oldDependencyRecord.importers.delete(record.id);
			}
		}

		record.imports = new Set();
		for (var i = 0; i < importedModuleIds.length; i++) {
			var importedModuleId = normalizeModuleId(importedModuleIds[i]);
			if (importedModuleId === record.id) {
				continue;
			}
			record.imports.add(importedModuleId);
			ensureModuleRecord(importedModuleId).importers.add(record.id);
		}
	}

	function clearHotState(record) {
		record.disposeHandlers = [];
		record.dependencyAcceptances = [];
		record.selfAccept = false;
		record.selfAcceptCallback = undefined;
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
			dispose: function (callback) {
				if (typeof callback === 'function') {
					record.disposeHandlers.push(callback);
				}
			},
			invalidate: function () {
				reloadPreview();
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

	function collectBoundaryPlans(changedModuleId) {
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

			if (record.selfAccept) {
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

		var dedupedPlans = new Map();
		for (var index = 0; index < plan.plans.length; index++) {
			var boundaryPlan = plan.plans[index];
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

	async function applyUpdate(update) {
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
	};
})();
