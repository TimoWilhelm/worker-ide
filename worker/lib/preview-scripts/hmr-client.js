/**
 * HMR Client for Preview
 *
 * Connects to the HMR WebSocket and handles:
 * - Full page reloads
 * - CSS hot-swap updates
 * - JS hot-swap updates
 * - Server error forwarding to parent IDE
 *
 * Reliability: the coordinator assigns a monotonically increasing version
 * number to every HMR broadcast. This client tracks the latest version it
 * has seen. When a full-reload triggers `location.reload()`, the version
 * is passed via the URL hash fragment (`#hmr-v=<N>`) so it survives the
 * navigation without depending on sessionStorage (which may be unavailable
 * in sandboxed iframes). On reconnect the client sends its last-seen
 * version; if the coordinator's version is higher the client missed an
 * update and gets an immediate full-reload.
 *
 * Reads config from window.__PREVIEW_CONFIG set by a tiny inline script:
 *   { wsUrl: string, baseUrl: string }
 */
(function () {
	var config = window.__PREVIEW_CONFIG;
	if (!config || !config.wsUrl) return;

	var socket = new WebSocket(config.wsUrl);
	var hmrBaseUrl = config.baseUrl || '';

	// -------------------------------------------------------------------------
	// Version tracking
	// -------------------------------------------------------------------------

	/**
	 * Read the last-seen HMR version from the URL hash fragment.
	 * Format: #hmr-v=<integer>  (may be mixed with other hash params in the future)
	 */
	function readVersionFromHash() {
		var match = location.hash.match(/hmr-v=(\d+)/);
		return match ? Number(match[1]) : 0;
	}

	/** Last HMR version this client has seen (survives reload via hash). */
	var lastVersion = readVersionFromHash();

	// Clean up the hash fragment so it doesn't leak into the user's app.
	// Use replaceState to avoid creating a history entry.
	if (lastVersion > 0) {
		try {
			var cleanHash = location.hash.replace(/hmr-v=\d+&?/, '').replace(/^#$/, '');
			history.replaceState(null, '', location.pathname + location.search + cleanHash);
		} catch (_) {
			// Sandboxed iframes may block replaceState — harmless.
		}
	}

	// -------------------------------------------------------------------------
	// Debounced reload
	// -------------------------------------------------------------------------

	// Debounce full-reload to coalesce rapid sequential updates.
	// When multiple file writes happen in quick succession (e.g., saving several files,
	// batch edits, or automated tools), each write triggers a full-reload message.
	// Without debouncing, the first reload tears down the page (and its WebSocket),
	// causing subsequent reload messages to be lost. The page may then show stale
	// content from an intermediate state.
	// By debouncing with a short delay, we wait for all writes to finish before reloading.
	var reloadTimer = null;
	var RELOAD_DEBOUNCE_MS = 200;

	function debouncedReload() {
		if (reloadTimer) clearTimeout(reloadTimer);
		reloadTimer = setTimeout(function () {
			reloadTimer = null;
			// Persist the last-seen version in the URL hash so the next page
			// load can send it on hmr-connect, allowing the coordinator to
			// detect any updates we missed during the reload window.
			var hash = '#hmr-v=' + lastVersion;
			location.replace(location.pathname + location.search + hash);
		}, RELOAD_DEBOUNCE_MS);
	}

	// -------------------------------------------------------------------------
	// Message handling
	// -------------------------------------------------------------------------

	socket.addEventListener('message', function (event) {
		var data = JSON.parse(event.data);

		// Track the coordinator's version from every HMR message.
		if (typeof data.version === 'number' && data.version > lastVersion) {
			lastVersion = data.version;
		}

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

	// -------------------------------------------------------------------------
	// Connection lifecycle
	// -------------------------------------------------------------------------

	socket.addEventListener('open', function () {
		console.log('[hmr] connected.');

		// Tell the coordinator the last version we saw. If any updates were
		// broadcast after this version, we missed them and need to reload.
		socket.send(JSON.stringify({ type: 'hmr-connect', lastVersion: lastVersion }));
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
