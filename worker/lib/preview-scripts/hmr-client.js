/**
 * HMR transport client for preview.
 *
 * Owns only connection lifecycle and version tracking. All update behavior
 * lives in `window.__PREVIEW_RUNTIME__`.
 */
(function () {
	var config = window.__PREVIEW_CONFIG;
	if (!config || !config.wsUrl) return;

	var socket = new WebSocket(config.wsUrl);
	var ideOrigin = config.ideOrigin || '*';
	var version = Number.isFinite(config.bootVersion) ? config.bootVersion : 0;

	var reloadTimer = null;
	var RELOAD_DEBOUNCE_MS = 200;

	function debouncedReload() {
		if (reloadTimer) clearTimeout(reloadTimer);
		reloadTimer = setTimeout(function () {
			reloadTimer = null;
			var runtimeReload = window.__PREVIEW_RUNTIME_RELOAD__;
			if (typeof runtimeReload === 'function') {
				runtimeReload();
				return;
			}
			location.reload();
		}, RELOAD_DEBOUNCE_MS);
	}

	async function applyUpdates(updates) {
		var runtime = window.__PREVIEW_RUNTIME__;
		if (!runtime || typeof runtime.applyUpdate !== 'function') {
			debouncedReload();
			return;
		}

		for (var index = 0; index < updates.length; index++) {
			await runtime.applyUpdate(updates[index]);
		}
	}

	socket.addEventListener('message', function (event) {
		var data = JSON.parse(event.data);

		if (typeof data.version === 'number' && data.version > version) {
			version = data.version;
		}

		if (data.type === 'full-reload') {
			debouncedReload();
			return;
		}

		if (data.type === 'server-error' && data.error) {
			if (typeof window.showErrorOverlay === 'function' && data.error.type === 'bundle') {
				window.showErrorOverlay(data.error);
			}
			if (window.parent !== window) {
				window.parent.postMessage(
					{
						type: '__server-error',
						error: data.error,
					},
					ideOrigin,
				);
			}
			return;
		}

		if (data.type === 'update') {
			if (typeof window.hideErrorOverlay === 'function') {
				window.hideErrorOverlay();
			}
			applyUpdates(data.updates).catch(function (error) {
				console.error('[hmr] update failed', error);
				debouncedReload();
			});
		}
	});

	socket.addEventListener('open', function () {
		console.log('[hmr] connected.');
		socket.send(JSON.stringify({ type: 'hmr-connect', version: version }));
	});

	socket.addEventListener('close', function () {
		console.log('[hmr] server connection lost. polling for restart...');
		function poll() {
			fetch(location.href, { method: 'HEAD' })
				.then(function () {
					location.reload();
				})
				.catch(function () {
					setTimeout(poll, 1000);
				});
		}
		setTimeout(poll, 1000);
	});

	setInterval(function () {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'ping' }));
		}
	}, 30000);
})();
