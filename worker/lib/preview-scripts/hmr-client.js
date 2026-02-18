/**
 * HMR Client for Preview
 *
 * Connects to the HMR WebSocket and handles:
 * - Full page reloads
 * - CSS hot-swap updates
 * - JS hot-swap updates
 * - Server error forwarding to parent IDE
 *
 * Reads config from window.__PREVIEW_CONFIG set by a tiny inline script:
 *   { wsUrl: string, baseUrl: string }
 */
(function () {
	var config = window.__PREVIEW_CONFIG;
	if (!config || !config.wsUrl) return;

	var socket = new WebSocket(config.wsUrl);
	var hmrBaseUrl = config.baseUrl || '';

	// Debounce full-reload to coalesce rapid sequential updates.
	// When multiple file writes happen in quick succession (e.g., saving several files,
	// batch edits, or automated tools), each write triggers a full-reload message.
	// Without debouncing, the first reload tears down the page (and its WebSocket),
	// causing subsequent reload messages to be lost. The page may then show stale
	// content from an intermediate state.
	// By debouncing with a short delay, we wait for all writes to finish before reloading.
	var reloadTimer = null;
	var RELOAD_DEBOUNCE_MS = 200;
	var HMR_RELOAD_TS_KEY = '__hmr_reload_ts';

	function debouncedReload() {
		if (reloadTimer) clearTimeout(reloadTimer);
		reloadTimer = setTimeout(function () {
			reloadTimer = null;
			// Store the reload timestamp so that after the page reloads and
			// a new WebSocket connects, we can ask the coordinator whether any
			// updates were broadcast during the reload window that we missed.
			try {
				sessionStorage.setItem(HMR_RELOAD_TS_KEY, String(Date.now()));
			} catch (_) {
				// sessionStorage may be unavailable in sandboxed iframes
			}
			location.reload();
		}, RELOAD_DEBOUNCE_MS);
	}

	socket.addEventListener('message', function (event) {
		var data = JSON.parse(event.data);

		if (data.type === 'full-reload') {
			debouncedReload();
		} else if (data.type === 'server-error' && data.error) {
			// Show overlay only for bundle errors, not runtime errors
			if (data.error.type === 'bundle' && typeof window.showErrorOverlay === 'function') {
				window.showErrorOverlay(data.error);
			}
			window.parent.postMessage(
				{
					type: '__server-error',
					error: data.error,
				},
				location.origin,
			);
		} else if (data.type === 'update') {
			if (typeof window.hideErrorOverlay === 'function') {
				window.hideErrorOverlay();
			}
			data.updates &&
				data.updates.forEach(function (update) {
					if (update.type === 'js-update') {
						import(hmrBaseUrl + update.path + '?t=' + update.timestamp).then(function () {
							console.log('[hmr] hot updated:', update.path);
						});
					} else if (update.type === 'css-update') {
						var style = document.querySelector('style[data-dev-id="' + update.path + '"]');
						if (style) {
							fetch(hmrBaseUrl + update.path + '?raw&t=' + update.timestamp)
								.then(function (r) {
									return r.text();
								})
								.then(function (css) {
									style.textContent = css;
									console.log('[hmr] css hot updated:', update.path);
								});
						}
					}
				});
		}
	});

	socket.addEventListener('open', function () {
		console.log('[hmr] connected.');

		// Negotiate with the coordinator: if any updates were broadcast
		// after our last reload, we may have missed them and need to reload again.
		var lastReloadTimestamp = 0;
		try {
			var stored = sessionStorage.getItem(HMR_RELOAD_TS_KEY);
			if (stored) {
				lastReloadTimestamp = Number(stored);
				sessionStorage.removeItem(HMR_RELOAD_TS_KEY);
			}
		} catch (_) {
			// sessionStorage may be unavailable in sandboxed iframes
		}
		socket.send(JSON.stringify({ type: 'hmr-connect', lastReloadTimestamp: lastReloadTimestamp }));
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

	// Keep connection alive
	setInterval(function () {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'ping' }));
		}
	}, 30000);
})();
