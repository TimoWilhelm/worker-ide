/**
 * HMR Client for Preview
 *
 * Connects to the HMR WebSocket and handles:
 * - Full page reloads (structural changes: file delete, move, git checkout, etc.)
 * - CSS hot-swap updates (replace <style> content or cache-bust <link> tags)
 * - JS hot updates with React Fast Refresh (re-bundle → re-execute → preserve state)
 * - Server error forwarding to parent IDE
 *
 * JS HMR flow:
 * 1. Server detects a JS/TS/JSX/TSX file change
 * 2. Server sends 'update' message with type 'js-update'
 * 3. This client fetches the fresh bundle from the preview URL
 * 4. Old bundle <script> is removed from the DOM
 * 5. New bundle <script> is injected and executes
 * 6. The bundle contains React Fast Refresh registration wrappers
 * 7. The bundle's postamble calls performReactRefresh()
 * 8. React swaps component families and preserves state
 *
 * CSS HMR flow:
 * - For CSS imported from JS: <style data-dev-id="..."> content is replaced
 * - For CSS loaded via <link>: href is cache-bust with timestamp
 *
 * Reliability: the coordinator assigns a monotonically increasing version
 * number to every HMR broadcast. This client tracks the latest version it
 * has seen. When a full-reload triggers location.reload(), the version
 * is passed via the URL hash fragment (#hmr-v=<N>) so it survives the
 * navigation without depending on sessionStorage (which may be unavailable
 * in sandboxed iframes). On reconnect the client sends its last-seen
 * version; if the coordinator's version is higher the client missed an
 * update and gets an immediate full-reload.
 *
 * Reads config from window.__PREVIEW_CONFIG set by a tiny inline script:
 *   { wsUrl: string, ideOrigin: string }
 */
(function () {
	var config = window.__PREVIEW_CONFIG;
	if (!config || !config.wsUrl) return;

	var socket = new WebSocket(config.wsUrl);
	var ideOrigin = config.ideOrigin || '*';

	// -------------------------------------------------------------------------
	// Version tracking
	// -------------------------------------------------------------------------

	function readVersionFromHash() {
		var match = location.hash.match(/hmr-v=(\d+)/);
		return match ? Number(match[1]) : 0;
	}

	var lastVersion = readVersionFromHash();

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

	var reloadTimer = null;
	var RELOAD_DEBOUNCE_MS = 200;

	function debouncedReload() {
		if (reloadTimer) clearTimeout(reloadTimer);
		reloadTimer = setTimeout(function () {
			reloadTimer = null;
			var hash = '#hmr-v=' + lastVersion;
			location.replace(location.pathname + location.search + hash);
		}, RELOAD_DEBOUNCE_MS);
	}

	// -------------------------------------------------------------------------
	// JS Hot Update
	// -------------------------------------------------------------------------

	var jsUpdateTimer = null;
	var JS_UPDATE_DEBOUNCE_MS = 100;
	var jsUpdateInFlight = false;
	var bundleScriptElement = null;

	function findBundleScript() {
		if (bundleScriptElement && bundleScriptElement.parentNode) {
			return bundleScriptElement;
		}
		var scripts = document.querySelectorAll('script[src]');
		for (var i = 0; i < scripts.length; i++) {
			var src = scripts[i].getAttribute('src') || '';
			// Internal preview scripts start with /__ (e.g. /__hmr-client.js)
			if (src.indexOf('/__') === -1) {
				bundleScriptElement = scripts[i];
				return bundleScriptElement;
			}
		}
		return null;
	}

	function performJsHotUpdate() {
		jsUpdateInFlight = true;
		var existingScript = findBundleScript();
		if (!existingScript) {
			console.log('[hmr] no bundle script found, falling back to full reload');
			jsUpdateInFlight = false;
			debouncedReload();
			return;
		}

		var baseSrc = existingScript.getAttribute('data-hmr-src') || existingScript.getAttribute('src');
		if (!existingScript.getAttribute('data-hmr-src')) {
			existingScript.setAttribute('data-hmr-src', baseSrc);
		}

		var cacheBustedSrc = baseSrc + (baseSrc.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();
		var isModule = existingScript.getAttribute('type') === 'module' || existingScript.getAttribute('data-hmr-module') === 'true';

		if (existingScript.parentNode) {
			existingScript.parentNode.removeChild(existingScript);
		}

		var newScript = document.createElement('script');
		newScript.setAttribute('data-hmr-src', baseSrc);

		if (isModule) {
			newScript.setAttribute('type', 'module');
			newScript.setAttribute('data-hmr-module', 'true');
		}

		newScript.src = cacheBustedSrc;

		newScript.addEventListener('load', function () {
			if (typeof window.hideErrorOverlay === 'function') {
				window.hideErrorOverlay();
			}
			console.log('[hmr] js hot updated');
			jsUpdateInFlight = false;
		});

		newScript.addEventListener('error', function () {
			console.error('[hmr] js hot update failed: script load error');
			jsUpdateInFlight = false;
		});

		document.body.appendChild(newScript);
		bundleScriptElement = newScript;
	}

	function scheduleJsHotUpdate() {
		if (jsUpdateTimer) clearTimeout(jsUpdateTimer);
		jsUpdateTimer = setTimeout(function () {
			jsUpdateTimer = null;
			if (jsUpdateInFlight) {
				scheduleJsHotUpdate();
				return;
			}
			performJsHotUpdate();
		}, JS_UPDATE_DEBOUNCE_MS);
	}

	// -------------------------------------------------------------------------
	// CSS Hot Update
	// -------------------------------------------------------------------------

	function performCssHotUpdate(updatePath, timestamp) {
		var style = document.querySelector('style[data-dev-id="' + updatePath + '"]');
		if (style) {
			fetch(updatePath + '?raw&t=' + timestamp)
				.then(function (r) {
					return r.text();
				})
				.then(function (css) {
					style.textContent = css;
					console.log('[hmr] css hot updated (style):', updatePath);
				});
			return;
		}

		var links = document.querySelectorAll('link[rel="stylesheet"]');
		for (var i = 0; i < links.length; i++) {
			var href = links[i].getAttribute('href') || '';
			var hrefPath = href.split('?')[0];
			if (hrefPath.endsWith(updatePath) || hrefPath === updatePath) {
				var baseHref = links[i].getAttribute('data-hmr-href') || hrefPath;
				if (!links[i].getAttribute('data-hmr-href')) {
					links[i].setAttribute('data-hmr-href', baseHref);
				}
				links[i].setAttribute('href', baseHref + '?t=' + timestamp);
				console.log('[hmr] css hot updated (link):', updatePath);
				return;
			}
		}

		console.log('[hmr] css update received but no matching element found:', updatePath);
	}

	// -------------------------------------------------------------------------
	// Message handling
	// -------------------------------------------------------------------------

	socket.addEventListener('message', function (event) {
		var data = JSON.parse(event.data);

		if (typeof data.version === 'number' && data.version > lastVersion) {
			lastVersion = data.version;
		}

		if (data.type === 'full-reload') {
			debouncedReload();
		} else if (data.type === 'server-error' && data.error) {
			if (data.error.type === 'bundle' && typeof window.showErrorOverlay === 'function') {
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
		} else if (data.type === 'update') {
			if (typeof window.hideErrorOverlay === 'function') {
				window.hideErrorOverlay();
			}

			var hasJsUpdate = false;
			data.updates &&
				data.updates.forEach(function (update) {
					if (update.type === 'js-update') {
						hasJsUpdate = true;
					} else if (update.type === 'css-update') {
						performCssHotUpdate(update.path, update.timestamp);
					}
				});

			if (hasJsUpdate) {
				scheduleJsHotUpdate();
			}
		}
	});

	// -------------------------------------------------------------------------
	// Connection lifecycle
	// -------------------------------------------------------------------------

	socket.addEventListener('open', function () {
		console.log('[hmr] connected.');
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

	setInterval(function () {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'ping' }));
		}
	}, 30000);
})();
