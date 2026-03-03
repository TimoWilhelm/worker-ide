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
 *    that re-register components with the runtime
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
	// JS Hot Update
	// -------------------------------------------------------------------------

	/** Debounce timer for JS updates — coalesces rapid file saves into one re-bundle. */
	var jsUpdateTimer = null;
	var JS_UPDATE_DEBOUNCE_MS = 100;
	/** Whether a JS hot update is currently in flight (fetching + executing). */
	var jsUpdateInFlight = false;
	/** Track the script element for the user's main bundle so we can replace it. */
	var bundleScriptElement = null;

	/**
	 * Find the user's main bundle <script> tag in the document.
	 * It's the <script src="..."> that points to a user file (not an internal __*.js script).
	 * We cache the reference so subsequent updates can replace it efficiently.
	 */
	function findBundleScript() {
		if (bundleScriptElement && bundleScriptElement.parentNode) {
			return bundleScriptElement;
		}
		var scripts = document.querySelectorAll('script[src]');
		for (var i = 0; i < scripts.length; i++) {
			var src = scripts[i].getAttribute('src') || '';
			// Internal preview scripts start with __ (e.g. __hmr-client.js)
			// User bundle scripts have paths like /p/:projectId/preview/src/main.tsx
			if (src.indexOf('/__') === -1 && src.indexOf(hmrBaseUrl) !== -1) {
				bundleScriptElement = scripts[i];
				return bundleScriptElement;
			}
		}
		return null;
	}

	/**
	 * Perform a JS hot update by re-fetching the bundle and replacing the script tag.
	 *
	 * The fresh bundle includes React Fast Refresh wrappers that:
	 * 1. Set $RefreshReg$ to a file-scoped registrar for each module
	 * 2. Call $RefreshReg$(Component, "ComponentName") for each detected component
	 * 3. Call performReactRefresh() in the postamble to trigger React state-preserving update
	 *
	 * For non-React projects, the bundle simply re-executes and the DOM is rebuilt.
	 * The React Fast Refresh calls are guarded by window.__RefreshRuntime checks
	 * and are effectively no-ops when the runtime is not available.
	 */
	function performJsHotUpdate() {
		jsUpdateInFlight = true;
		var existingScript = findBundleScript();
		if (!existingScript) {
			// No bundle script found — fall back to full reload.
			console.log('[hmr] no bundle script found, falling back to full reload');
			jsUpdateInFlight = false;
			debouncedReload();
			return;
		}

		// Get the original src URL (without any cache-buster query params we may have added).
		// We store it in a data attribute so we always re-fetch the canonical bundle URL.
		var baseSrc = existingScript.getAttribute('data-hmr-src') || existingScript.getAttribute('src');
		if (!existingScript.getAttribute('data-hmr-src')) {
			existingScript.setAttribute('data-hmr-src', baseSrc);
		}

		var cacheBustedSrc = baseSrc + (baseSrc.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();

		// Check if the original script is a module script (type="module").
		// User projects typically use <script type="module" src="src/main.tsx">.
		var isModule = existingScript.getAttribute('type') === 'module' || existingScript.getAttribute('data-hmr-module') === 'true';

		// Remove the old script element. We must do this BEFORE creating the new one
		// to avoid duplicate side-effects from both executing simultaneously.
		if (existingScript.parentNode) {
			existingScript.parentNode.removeChild(existingScript);
		}

		// Create a new script element that loads the fresh bundle from the server.
		// The server re-bundles on each request (no caching), so the cache-busted
		// URL always returns the latest code.
		//
		// We use a src-based script (not inline textContent) because:
		// 1. CSP allows 'self' scripts — same-origin URLs work, but blob: URLs may not
		// 2. Module scripts require external src for proper ESM execution
		// 3. The server's cache-busting via ?t= ensures fresh content
		var newScript = document.createElement('script');
		newScript.setAttribute('data-hmr-src', baseSrc);

		if (isModule) {
			newScript.setAttribute('type', 'module');
			newScript.setAttribute('data-hmr-module', 'true');
		}

		newScript.src = cacheBustedSrc;

		// Handle load success
		newScript.addEventListener('load', function () {
			if (typeof window.hideErrorOverlay === 'function') {
				window.hideErrorOverlay();
			}
			console.log('[hmr] js hot updated');
			jsUpdateInFlight = false;
		});

		// Handle load failure
		newScript.addEventListener('error', function () {
			console.error('[hmr] js hot update failed: script load error');
			jsUpdateInFlight = false;
			// On bundle error, the server broadcasts a server-error message
			// with details for the error overlay. No action needed here.
		});

		document.body.appendChild(newScript);

		// Cache the new script element for future updates
		bundleScriptElement = newScript;
	}

	/**
	 * Schedule a debounced JS hot update. Multiple rapid file saves are coalesced
	 * into a single re-bundle + refresh cycle.
	 */
	function scheduleJsHotUpdate() {
		if (jsUpdateTimer) clearTimeout(jsUpdateTimer);
		jsUpdateTimer = setTimeout(function () {
			jsUpdateTimer = null;
			// If a previous update is still in flight, wait for it to finish
			// then schedule another one.
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

	/**
	 * Handle a CSS hot update for a specific file path.
	 *
	 * Supports two CSS loading mechanisms:
	 * 1. CSS imported from JS — creates <style data-dev-id="path"> tags
	 *    → We fetch raw CSS and replace the style's textContent
	 * 2. CSS loaded via <link rel="stylesheet"> tags
	 *    → We cache-bust the href to force the browser to re-fetch
	 */
	function performCssHotUpdate(updatePath, timestamp) {
		// Strategy 1: Update <style data-dev-id="..."> elements (CSS imported from JS)
		var style = document.querySelector('style[data-dev-id="' + updatePath + '"]');
		if (style) {
			fetch(hmrBaseUrl + updatePath + '?raw&t=' + timestamp)
				.then(function (r) {
					return r.text();
				})
				.then(function (css) {
					style.textContent = css;
					console.log('[hmr] css hot updated (style):', updatePath);
				});
			return;
		}

		// Strategy 2: Cache-bust <link rel="stylesheet"> elements
		// The href may include the preview base URL prefix, so we check both forms
		var links = document.querySelectorAll('link[rel="stylesheet"]');
		for (var i = 0; i < links.length; i++) {
			var href = links[i].getAttribute('href') || '';
			// Strip query params for path comparison
			var hrefPath = href.split('?')[0];
			if (hrefPath.endsWith(updatePath) || hrefPath === hmrBaseUrl + updatePath) {
				// Preserve the original href for future cache-busting
				var baseHref = links[i].getAttribute('data-hmr-href') || hrefPath;
				if (!links[i].getAttribute('data-hmr-href')) {
					links[i].setAttribute('data-hmr-href', baseHref);
				}
				links[i].setAttribute('href', baseHref + '?t=' + timestamp);
				console.log('[hmr] css hot updated (link):', updatePath);
				return;
			}
		}

		// No matching element found — CSS might be dynamically loaded later
		console.log('[hmr] css update received but no matching element found:', updatePath);
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

			var hasJsUpdate = false;
			data.updates &&
				data.updates.forEach(function (update) {
					if (update.type === 'js-update') {
						hasJsUpdate = true;
					} else if (update.type === 'css-update') {
						performCssHotUpdate(update.path, update.timestamp);
					}
				});

			// For JS updates, schedule a debounced re-bundle.
			// All JS updates are batched into a single re-bundle since the
			// bundler produces one output from all source files.
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
